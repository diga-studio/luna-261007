export interface Ping {
  pingId: string;
  employeeId: string;
  deviceId: string;
  /** Unix epoch milliseconds */
  timestamp: number;
  latitude: number;
  longitude: number;
  /** accuracy in feet */
  accuracy: number;
}
