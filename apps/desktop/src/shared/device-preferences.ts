export const USB_RETRY_INTERVALS = ["backoff", 1000, 2000, 5000, 10000] as const;
export const USB_RETRY_LIMITS = ["unlimited", 3, 5, 10] as const;
export const WIFI_CONNECT_TIMEOUTS = [3000, 5000, 10000, 30000] as const;
export const WIFI_HANDSHAKE_TIMEOUTS = [1000, 3000, 5000, 10000] as const;

export interface DevicePreferences {
  usbAutoReconnect: boolean;
  usbRetryInterval: (typeof USB_RETRY_INTERVALS)[number];
  usbRetryLimit: (typeof USB_RETRY_LIMITS)[number];
  wifiConnectTimeout: (typeof WIFI_CONNECT_TIMEOUTS)[number];
  wifiHandshakeTimeout: (typeof WIFI_HANDSHAKE_TIMEOUTS)[number];
}

export const DEFAULT_DEVICE_PREFERENCES: DevicePreferences = {
  usbAutoReconnect: true,
  usbRetryInterval: "backoff",
  usbRetryLimit: "unlimited",
  wifiConnectTimeout: 5000,
  wifiHandshakeTimeout: 3000,
};
