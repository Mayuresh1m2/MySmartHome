export interface DeviceInfo {
  id: string;
  name: string;
}

/** How tools reach devices. M2 has a static devices.json implementation; M5 makes it capability-based. */
export interface DeviceGateway {
  list(): Promise<DeviceInfo[]>;
  /** Finds a device by id, name or alias (case-insensitive). */
  find(nameOrAlias: string): Promise<DeviceInfo | undefined>;
  isOnline(id: string): Promise<boolean>;
}
