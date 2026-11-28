// Run inside the private broker so the bind that owns the live socket can
// report SocketException.NativeErrorCode before any translation by libuv.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Text.Json;

public sealed class ProbeReceiver {
  public readonly ConcurrentQueue<object> Events =
      new ConcurrentQueue<object>();
  readonly Socket socket;
  readonly bool tcp;
  readonly string host, label, protocol;
  readonly int pid = Environment.ProcessId;
  readonly Thread worker;
  volatile bool stopping;
  public int Port { get; }

  public ProbeReceiver(string address, string protocol, string label,
                       bool reserveOnly) {
    this.host = address;
    this.protocol = protocol;
    this.label = label;
    var ip = IPAddress.Parse(address);
    tcp = protocol == "tcp";
    string operation = "socket";
    try {
      socket = new Socket(ip.AddressFamily,
                          tcp ? SocketType.Stream : SocketType.Dgram,
                          tcp ? ProtocolType.Tcp : ProtocolType.Udp);
      operation = "bind";
      socket.Bind(new IPEndPoint(ip, 0));
      Port = ((IPEndPoint)socket.LocalEndPoint).Port;
      if (reserveOnly)
        return;
      operation = "listen";
      if (tcp)
        socket.Listen(32);
      worker = new Thread(Run) { IsBackground = true };
      worker.Start();
    } catch (SocketException e) {
      e.Data["operation"] = operation;
      socket?.Dispose();
      throw;
    } catch {
      socket?.Dispose();
      throw;
    }
  }

  void Record(string action, IPEndPoint peer, string nonce, int? wsa = null) {
    var data = new { host,
                     label,
                     protocol,
                     pid,
                     port = Port,
                     at = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                     remoteAddress = peer?.Address.ToString(),
                     remotePort = peer?.Port,
                     @event = action,
                     nonce,
                     wsa };
    Console.Out.WriteLine(
        JsonSerializer.Serialize(new { kind = "listener", data }));
    Events.Enqueue(data);
  }

  void Echo(Socket client, IPEndPoint peer, string payload) {
    Guid id;
    bool valid =
        Guid.TryParseExact(payload, "D", out id) && id.ToString("D") == payload;
    Record(tcp ? "request" : "datagram", peer, valid ? payload : "invalid");
    if (!valid)
      return;
    byte[] bytes =
        Encoding.ASCII.GetBytes("reply:" + payload + (tcp ? "\n" : ""));
    if (tcp) {
      for (int sent = 0; sent < bytes.Length;)
        sent += client.Send(bytes, sent, bytes.Length - sent, SocketFlags.None);
    } else
      client.SendTo(bytes, peer);
  }

  void Run() {
    var buffer = new byte[128];
    try {
      while (!stopping) {
        if (tcp) {
          using (var client = socket.Accept()) {
            var peer = (IPEndPoint)client.RemoteEndPoint;
            Record("accept", peer, null);
            client.ReceiveTimeout = client.SendTimeout = 3000;
            try {
              int n = 0;
              while (n < buffer.Length) {
                int received = client.Receive(buffer, n, buffer.Length - n,
                                              SocketFlags.None);
                if (received == 0)
                  break;
                n += received;
                if (buffer[n - 1] == 10) {
                  Echo(client, peer,
                       Encoding.ASCII.GetString(buffer, 0, n - 1));
                  break;
                }
              }
            } catch (SocketException e) {
              Record("connection error", peer, null, e.NativeErrorCode);
            }
          }
        } else {
          EndPoint peer =
              new IPEndPoint(socket.AddressFamily == AddressFamily.InterNetwork
                                 ? IPAddress.Any
                                 : IPAddress.IPv6Any,
                             0);
          int n = socket.ReceiveFrom(buffer, ref peer);
          Echo(socket, (IPEndPoint)peer,
               Encoding.ASCII.GetString(buffer, 0, n));
        }
      }
    } catch (ObjectDisposedException) {
    } catch (SocketException e) {
      Record(stopping ? "receive interrupted during shutdown" : "receiver stopped", null, null, e.NativeErrorCode);
    }
  }

  public object[] Drain() {
    var records = new List<object>();
    object item;
    while (Events.TryDequeue(out item))
      records.Add(item);
    return records.ToArray();
  }
  public void Close() { stopping = true; socket.Dispose(); }
  public void Join() {
    worker?.Join();
    Record("receiver joined", null, null);
    Console.Out.Flush();
  }
}
