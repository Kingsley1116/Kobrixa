// Query only our own Mach task. Build into the transient fixture profile.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { pageProbe } from "./b2-process-rss-attribution-pages.mjs";

export function darwinProbe(profile) {
  if (process.platform !== "darwin") return {};
  const target = path.join(profile, "vm-observer.node");
  execFileSync(
    "clang",
    [
      "-O2",
      "-bundle",
      "-undefined",
      "dynamic_lookup",
      "-I",
      process.env.NODE_INCLUDE_DIR ??
        path.resolve(path.dirname(process.execPath), "../include/node"),
      "-x",
      "c",
      "-",
      "-o",
      target,
    ],
    {
      input: `
#include <node_api.h>
#include <mach/mach.h>
#include <mach/mach_vm.h>
#include <malloc/malloc.h>
#include <unistd.h>

static void field(napi_env env, napi_value obj, const char *key, double size) {
  napi_value value;
  napi_create_double(env, size, &value);
  napi_set_named_property(env, obj, key, value);
}
${process.env.W16A_FREE_PAGES ? pageProbe : ""}
static napi_value regions(napi_env env, napi_callback_info info) {
  napi_value obj;
  napi_create_object(env,&obj);
  mach_vm_address_t address = 0;
  mach_vm_size_t size;
  natural_t depth = 0;
  uint64_t stack = 0, executable = 0, mallocResident = 0, reusable = 0;
  for (;;) {
    vm_region_submap_info_data_64_t r;
    mach_msg_type_number_t count = VM_REGION_SUBMAP_INFO_COUNT_64;
    kern_return_t status = mach_vm_region_recurse(mach_task_self(), &address, &size, &depth,
      (vm_region_recurse_info_t)&r, &count);
    if (status == KERN_INVALID_ADDRESS) break;
    if (status != KERN_SUCCESS || !size) {
      napi_throw_error(env, NULL, "mach_vm_region_recurse failed");
      return NULL;
    }
    if (r.is_submap) { depth++; continue; }
    if (r.user_tag == VM_MEMORY_STACK) stack += r.pages_resident;
    if (r.protection & VM_PROT_EXECUTE) executable += r.pages_resident;
    switch (r.user_tag) {
      case VM_MEMORY_MALLOC: case VM_MEMORY_MALLOC_SMALL: case VM_MEMORY_MALLOC_LARGE:
      case VM_MEMORY_MALLOC_HUGE: case VM_MEMORY_MALLOC_TINY: case VM_MEMORY_MALLOC_NANO:
      case VM_MEMORY_MALLOC_MEDIUM: case VM_MEMORY_MALLOC_LARGE_REUSABLE:
      case VM_MEMORY_MALLOC_LARGE_REUSED:
        mallocResident += r.pages_resident; reusable += r.pages_reusable; break;
    }
    if (address + size <= address) break;
    address += size;
  }
  const uint64_t page = getpagesize();
  malloc_statistics_t stats;
  malloc_zone_statistics(NULL, &stats);
  field(env,obj,"stackResident",stack*page);
  field(env,obj,"executableResidentIncludingShared",executable*page);
  field(env,obj,"mallocTaggedResident",mallocResident*page);
  field(env,obj,"mallocTaggedReusable",reusable*page);
  field(env,obj,"mallocInUse",stats.size_in_use);
  field(env,obj,"mallocAllocated",stats.size_allocated);
  return obj;
}
static napi_value relief(napi_env env, napi_callback_info info) {
  napi_value value;
  napi_create_double(env, malloc_zone_pressure_relief(NULL,0), &value);
  return value;
}
static napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {
    ${process.env.W16A_FREE_PAGES ? '{ .utf8name="freePages", .method=free_pages },' : ""}
    { .utf8name="regions", .method=regions },
    { .utf8name="relief", .method=relief }
  };
  napi_define_properties(env,exports,sizeof(props)/sizeof(props[0]),props);
  return exports;
}
NAPI_MODULE(vm_observer, init)
`,
    },
  );
  return createRequire(import.meta.url)(target);
}
