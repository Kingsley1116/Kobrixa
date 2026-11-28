// Extra diagnostic, enabled only by W16A_FREE_PAGES. Use fixed storage to
// avoid allocating on the observed malloc zones during range enumeration.
export const pageProbe = `
#include <stdlib.h>

#define RANGE_LIMIT 262144
static vm_range_t blocks[RANGE_LIMIT], regions_list[RANGE_LIMIT];
static unsigned block_count, region_count;
static int overflow;

static kern_return_t local_reader(task_t task, vm_address_t address, vm_size_t size, void **out) {
  *out = (void *)address;
  return KERN_SUCCESS;
}
static void record_ranges(task_t task, void *ctx, unsigned type, vm_range_t *ranges, unsigned count) {
  // Include allocator administration as occupied, even if it overlaps user regions.
  int occupied = type & (MALLOC_PTR_IN_USE_RANGE_TYPE | MALLOC_ADMIN_REGION_RANGE_TYPE);
  unsigned *length = occupied ? &block_count : &region_count;
  vm_range_t *target = occupied ? blocks : regions_list;
  if (count > RANGE_LIMIT - *length) { overflow = 1; return; }
  for (unsigned i=0; i<count; i++) target[(*length)++] = ranges[i];
}
static int compare_ranges(const void *a, const void *b) {
  vm_address_t x = ((const vm_range_t*)a)->address, y = ((const vm_range_t*)b)->address;
  return x < y ? -1 : x > y;
}
static int query_gap(vm_address_t start, vm_address_t end, uint64_t *present, uint64_t *reusable) {
  vm_size_t page = getpagesize();
  start = (start + page - 1) & ~(page-1);
  end &= ~(page-1);
  while (start < end) {
    int dispositions[1024];
    mach_vm_size_t n = (end-start)/page;
    if (n > 1024) n = 1024;
    mach_vm_size_t received = n;
    if (mach_vm_page_range_query(mach_task_self(),start,n*page,(mach_vm_address_t)dispositions,&received) != KERN_SUCCESS || received != n) return 0;
    for (unsigned i=0; i<n; i++) {
      if (dispositions[i] & VM_PAGE_QUERY_PAGE_PRESENT) {
        *present += page;
        if (dispositions[i] & VM_PAGE_QUERY_PAGE_REUSABLE) *reusable += page;
      }
    }
    start += n*page;
  }
  return 1;
}
static napi_value free_pages(napi_env env, napi_callback_info info) {
  block_count = region_count = overflow = 0;
  vm_address_t *zones;
  unsigned count;
  if (malloc_get_all_zones(mach_task_self(),local_reader,&zones,&count) != KERN_SUCCESS) goto failed;
  for (unsigned i=0; i<count; i++) {
    malloc_zone_t *zone=(malloc_zone_t*)zones[i];
    if (!zone->introspect || !zone->introspect->enumerator) goto failed;
    if (zone->introspect->enumerator(mach_task_self(),NULL,
        MALLOC_PTR_IN_USE_RANGE_TYPE|MALLOC_PTR_REGION_RANGE_TYPE|MALLOC_ADMIN_REGION_RANGE_TYPE,
        zones[i],local_reader,record_ranges) != KERN_SUCCESS || overflow) goto failed;
  }
  qsort(blocks,block_count,sizeof(vm_range_t),compare_ranges);
  qsort(regions_list,region_count,sizeof(vm_range_t),compare_ranges);
  uint64_t present=0,reusable=0;
  unsigned b=0;
  for (unsigned i=0; i<region_count; i++) {
    vm_address_t pos=regions_list[i].address,end=pos+regions_list[i].size;
    while (i+1<region_count && regions_list[i+1].address<=end) {
      i++;
      vm_address_t next=regions_list[i].address+regions_list[i].size;
      if (next>end) end=next;
    }
    while (b<block_count && blocks[b].address<end) {
      vm_address_t start=blocks[b].address, stop=start+blocks[b].size;
      if (start>pos && !query_gap(pos,start,&present,&reusable)) goto failed;
      if (stop>pos) pos=stop;
      if (stop>end) break;
      b++;
    }
    if (!query_gap(pos,end,&present,&reusable)) goto failed;
  }
  napi_value obj;
  napi_create_object(env,&obj);
  field(env,obj,"fullyVacantResident",present);
  field(env,obj,"vacantResidentReusable",reusable);
  field(env,obj,"zones",count);
  field(env,obj,"occupiedRanges",block_count);
  field(env,obj,"pointerRegions",region_count);
  return obj;
failed:
  napi_throw_error(env,NULL,"malloc range enumeration or Mach page query failed");
  return NULL;
}
`;
