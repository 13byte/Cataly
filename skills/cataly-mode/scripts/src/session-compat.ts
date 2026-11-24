export const parseCatalyRole = (value: unknown): "cataly" | "lane" | undefined =>
  value === "cataly" || value === "lane" ? value : undefined;

export const isCatalyEntry = (value: unknown, current: `omp-cataly:${string}`): boolean => value === current;

export const SESSION_WIRE = {
  role: "omp-cataly:role",
  monitor: "omp-cataly:monitor",
  intake: "omp-cataly:intake",
  monitorBootstrap: "omp-cataly:monitor-bootstrap",
  lanePolicy: "omp-cataly:lane-policy",
  laneReceiver: "omp-cataly:discord-lane-receiver",
  askLane: "omp-cataly:discord-ask-lane",
  remoteOwner: "omp-cataly:native-remote-owner",
  admissionRejected: "omp-cataly:admission-rejected",
  monitorMessage: "cataly-monitor",
} as const;

export const MONITOR_MESSAGE = SESSION_WIRE.monitorMessage;
export const isMonitorMessage = (value: unknown): boolean => value === MONITOR_MESSAGE;
