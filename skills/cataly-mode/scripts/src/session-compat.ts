/** Only these exact historical field values are aliases. Contents and record identities remain opaque. */
export const parseCatalyRole = (value: unknown): "cataly" | "lane" | undefined => {
  if (value === "cataly" || value === "dori") return "cataly";
  if (value === "lane") return "lane";
  return undefined;
};

export const isCatalyEntry = (value: unknown, current: `omp-cataly:${string}`): boolean =>
  value === current || value === `omp-dori:${current.slice("omp-cataly:".length)}`;

export const MONITOR_MESSAGE = "cataly-monitor";
export const isMonitorMessage = (value: unknown): boolean => value === MONITOR_MESSAGE || value === "dori-monitor";
