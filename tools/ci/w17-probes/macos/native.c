// Emit each call as it completes. A failed observation never supplies SO_ERROR.
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <poll.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

static void observation(const char *name, int result, int error) {
  printf(",\"%s\":{\"result\":%d,\"errno\":%d}", name, result, error);
}

int main(int argc, char **argv) {
  uint64_t start = clock_gettime_nsec_np(CLOCK_MONOTONIC);
  printf("{\"pid\":%d,\"ppid\":%d,\"uid\":%d", getpid(), getppid(), geteuid());
  if (argc == 3 && !strcmp(argv[1], "open")) {
    int fd = open(argv[2], O_RDONLY);
    observation("open", fd, fd < 0 ? errno : 0);
    if (fd >= 0) {
      char byte;
      int n = (int)read(fd, &byte, 1);
      observation("read", n, n < 0 ? errno : 0);
      close(fd);
    }
  } else if (argc == 5) {
    int tcp = !strcmp(argv[1], "tcp");
    struct addrinfo hints = {0}, *addr = NULL;
    hints.ai_flags = AI_NUMERICHOST | AI_NUMERICSERV;
    hints.ai_socktype = tcp ? SOCK_STREAM : SOCK_DGRAM;
    int gai = getaddrinfo(argv[2], argv[3], &hints, &addr);
    printf(",\"getaddrinfo\":%d", gai);
    if (!gai) {
      int fd = socket(addr->ai_family, hints.ai_socktype, 0);
      observation("socket", fd, fd < 0 ? errno : 0);
      if (fd >= 0) {
        int flags = fcntl(fd, F_SETFL, O_NONBLOCK);
        observation("fcntl", flags, flags < 0 ? errno : 0);
        if (flags >= 0 && tcp) {
          int rc = connect(fd, addr->ai_addr, addr->ai_addrlen);
          int error = rc < 0 ? errno : 0;
          observation("connect", rc, error);
          if (error == EINPROGRESS) {
            struct pollfd p = {.fd = fd, .events = POLLOUT};
            int ready = poll(&p, 1, 2000);
            observation("poll", ready, ready < 0 ? errno : 0);
            printf(",\"revents\":%d", p.revents);
            if (ready == 0)
              printf(",\"event\":\"TIMEOUT\"");
            else if (ready > 0 && !(p.revents & POLLNVAL) &&
                     (p.revents & (POLLOUT | POLLERR | POLLHUP))) {
              socklen_t len = sizeof(error);
              rc = getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &len);
              observation("getsockopt", rc, rc < 0 ? errno : 0);
              if (rc == 0 && len == sizeof(error))
                printf(",\"completedConnectErrno\":%d", error);
            }
          } else {
            printf(",\"completedConnectErrno\":%d", error);
          }
        } else if (flags >= 0) {
          int n = (int)sendto(fd, argv[4], strlen(argv[4]), 0, addr->ai_addr,
                              addr->ai_addrlen);
          observation("sendto", n, n < 0 ? errno : 0);
        }
        close(fd);
      }
      freeaddrinfo(addr);
    }
  } else {
    puts(",\"event\":\"invalid arguments\"}");
    return 64;
  }
  printf(",\"elapsed\":%.3f}\n",
         (clock_gettime_nsec_np(CLOCK_MONOTONIC) - start) / 1e6);
  return 0;
}
