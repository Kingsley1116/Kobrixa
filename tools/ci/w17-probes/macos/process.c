// Print identity metadata only. Never read controller process memory.
#include <bsm/audit.h>
#include <dlfcn.h>
#include <errno.h>
#include <libproc.h>
#include <mach/mach.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc != 3)
    return 64;
  pid_t pid = atoi(argv[2]);
  if (pid < 1)
    return 64;
#ifdef SUBJECT_ACCESS_ONLY
  if (!strcmp(argv[1], "access")) {
    mach_port_t port = MACH_PORT_NULL;
    kern_return_t kr = task_for_pid(mach_task_self(), pid, &port);
    if (port != MACH_PORT_NULL)
      mach_port_deallocate(mach_task_self(), port);
    printf("{\"uid\":%u,\"machResult\":%d,\"denied\":%s}\n", geteuid(), kr,
           kr == KERN_FAILURE || kr == KERN_PROTECTION_FAILURE ? "true"
                                                               : "false");
    return 0;
  }
  return 64;
#else
  if (!strcmp(argv[1], "sandbox")) {
    typedef int (*sandbox_query)(pid_t, const char *, int, ...);
    void *lib = dlopen("/usr/lib/libsandbox.1.dylib", RTLD_LOCAL | RTLD_LAZY);
    sandbox_query check =
        lib ? (sandbox_query)dlsym(lib, "sandbox_check") : NULL;
    printf("{\"pid\":%d,\"sandboxed\":%d}\n", pid,
           check ? check(pid, NULL, 0) : -1);
    return 0;
  }
  struct proc_bsdinfo b = {0};
  if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &b, sizeof(b)) != sizeof(b))
    return 1;
  auditpinfo_addr_t audit = {.ap_pid = pid};
  int rc = auditon(A_GETPINFO_ADDR, &audit, sizeof(audit));
  printf("{\"pid\":%d,\"ppid\":%u,\"uid\":%u,\"birth\":\"%llu.%06llu\","
         "\"asid\":%d}\n",
         pid, b.pbi_ppid, b.pbi_uid, b.pbi_start_tvsec, b.pbi_start_tvusec,
         rc ? -1 : (int)audit.ap_asid);
  return 0;
#endif
}
