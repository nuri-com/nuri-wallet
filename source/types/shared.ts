// Centralized types for shared cross-domain definitions

export type BalanceToken =
  | { key: string; type: "digit"; char: string; leading: boolean }
  | { key: string; type: "dot"; char: string }
  | { key: string; type: "spacer" };

export type IconProps = {
  size?: number;
};

export type LogLevel = "info" | "success" | "error";

export type DebugLogEntry = {
  id: string | number;
  text: string;
  level: LogLevel;
};
