// Unnumbered 512-byte HID reports. The only accepted VM program is the
// product monitor snapshot. USB discover/connect themselves do no VM I/O.
#define _POSIX_C_SOURCE 200809L
#include "snapshot.h"
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum { REPORT = 512, GLOBALS = 376, REPLY = 5 + GLOBALS };

static int matches(const uint8_t *p, size_t n) {
  const size_t frame = 4 + sizeof snapshot;
  if (n < frame || n > REPORT || (p[0] | (p[1] << 8)) != (int)frame - 2 ||
      memcmp(p + 4, snapshot, sizeof snapshot))
    return 0;
  for (size_t i = frame; i < n; ++i)
    if (p[i])
      return 0;
  return 1;
}

static void put_float(uint8_t *p, float value) {
  uint32_t bits;
  _Static_assert(sizeof value == sizeof bits, "requires binary32 floats");
  memcpy(&bits, &value, sizeof bits);
  for (int i = 0; i < 4; ++i)
    p[i] = (uint8_t)(bits >> (8 * i));
}

static int answer(const uint8_t *p, size_t n, uint8_t out[REPORT]) {
  static unsigned sample;
  // hidraw writes include a zero report ID; the transport may remove it.
  if (n && !p[0]) {
    ++p;
    --n;
  }
  if (!matches(p, n)) {
    fprintf(stderr, "Unknown or malformed EV3 direct command (%zu bytes)\n", n);
    return -1;
  }
  memset(out, 0, REPORT);
  out[0] = (REPLY - 2) & 255;
  out[1] = (REPLY - 2) >> 8;
  out[2] = p[2];
  out[3] = p[3];
  out[4] = 2;
  uint8_t *g = out + 5, *input = g + 8;
  g[0] = 0x40;
  g[2] = 85;
  put_float(g + 4, 7.5f);
  input[0] = input[10] = 29; // stable type/mode before and after read
  input[2] = 122;
  input[4] = input[6] = input[7] = 1;
  memcpy(input + 12, "Spike sensor", 12);
  memcpy(input + 28, "unit", 4);
  sample = sample % 65535 + 1;
  put_float(input + 36, (float)sample);
  for (int i = 1; i < 4; ++i)
    input[68 * i] = 126;
  for (int i = 0; i < 4; ++i)
    g[280 + 24 * i] = 126;
  return 0;
}

#ifdef FRAME_TEST
// Length-delimited reports for the portable protocol test.
int main(void) {
  uint8_t request[REPORT + 1], reply[REPORT];
  int lo, hi;
  while ((lo = getchar()) != EOF) {
    if ((hi = getchar()) == EOF)
      return 1;
    size_t n = (size_t)(hi * 256 + lo);
    if (n > sizeof request || fread(request, 1, n, stdin) != n ||
        answer(request, n, reply) || fwrite(reply, 1, REPORT, stdout) != REPORT)
      return 1;
  }
  return ferror(stdin) || fflush(stdout);
}
#else
#include <fcntl.h>
#include <linux/uhid.h>
#include <time.h>
#include <unistd.h>

static void trace(const char *event, const uint8_t *bytes, size_t n) {
  struct timespec t;
  if (clock_gettime(CLOCK_MONOTONIC, &t)) {
    perror("clock_gettime");
    exit(1);
  }
  printf("%lld.%09ld %s", (long long)t.tv_sec, t.tv_nsec, event);
  if (bytes)
    putchar(' ');
  for (size_t i = 0; i < n; ++i)
    printf("%02x", bytes[i]);
  putchar('\n');
  if (fflush(stdout)) {
    perror("trace");
    exit(1);
  }
}

static void send_event(int fd, struct uhid_event *event) {
  if (write(fd, event, sizeof *event) != sizeof *event) {
    perror("UHID write");
    exit(1);
  }
}

int main(int argc, char **argv) {
  // Vendor-defined application collection, byte-aligned input and output,
  // 512 bytes each. No report ID in either direction.
  static const uint8_t descriptor[] = {0x06, 0x00, 0xff, 0x09, 0x01, 0xa1, 0x01,
                                       0x15, 0x00, 0x26, 0xff, 0x00, 0x75, 0x08,
                                       0x96, 0x00, 0x02, 0x09, 0x02, 0x81, 0x02,
                                       0x09, 0x03, 0x91, 0x02, 0xc0};
  // The service opens only this fd before dropping privileges.
  int fd;
  if (argc == 2 && strcmp(argv[1], "--fd3") == 0)
    fd = 3;
  else if (argc == 1)
    fd = open("/dev/uhid", O_RDWR | O_CLOEXEC);
  else {
    fprintf(stderr, "Usage: %s [--fd3]\n", argv[0]);
    return 1;
  }
  if (fd < 0) {
    perror("open /dev/uhid");
    return 1;
  }
  struct uhid_event create = {.type = UHID_CREATE2};
  struct uhid_create2_req *dev = &create.u.create2;
  strcpy((char *)dev->name, "Kobrixa UHID spike");
  strcpy((char *)dev->uniq, "kobrixa-uhid-spike");
  dev->bus = BUS_USB;
  dev->vendor = 0x0694;
  dev->product = 5;
  dev->rd_size = sizeof descriptor;
  memcpy(dev->rd_data, descriptor, sizeof descriptor);
  send_event(fd, &create);
  trace("CREATE", descriptor, sizeof descriptor);
  for (;;) {
    struct uhid_event e = {0};
    if (read(fd, &e, sizeof e) < (ssize_t)sizeof e.type) {
      perror("UHID read");
      return 1;
    }
    switch (e.type) {
    case UHID_START:
      trace("START", NULL, 0);
      break;
    case UHID_OPEN:
      trace("OPEN", NULL, 0);
      break;
    case UHID_CLOSE:
      trace("CLOSE", NULL, 0);
      break;
    case UHID_STOP:
      trace("STOP", NULL, 0);
      return 1;
    case UHID_OUTPUT: {
      struct uhid_event reply = {.type = UHID_INPUT2};
      size_t n = e.u.output.size;
      if (n > sizeof e.u.output.data)
        return 1;
      trace("REQUEST", e.u.output.data, n);
      if (e.u.output.rtype != UHID_OUTPUT_REPORT ||
          answer(e.u.output.data, n, reply.u.input2.data)) {
        trace("REJECT", NULL, 0);
        return 1;
      }
      reply.u.input2.size = REPORT;
      send_event(fd, &reply);
      trace("REPLY", reply.u.input2.data, REPORT);
      break;
    }
    case UHID_SET_REPORT:
      if (e.u.set_report.size <= sizeof e.u.set_report.data)
        trace("SET_REPORT", e.u.set_report.data, e.u.set_report.size);
      trace("REJECT", NULL, 0);
      return 1;
    case UHID_GET_REPORT:
      trace("GET_REPORT", &e.u.get_report.rnum, 1);
      trace("REJECT", NULL, 0);
      return 1;
    default:
      fprintf(stderr, "Unsupported UHID event %u\n", e.type);
      return 1;
    }
  }
}
#endif
