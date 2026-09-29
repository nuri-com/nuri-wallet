const pad2 = (value: number): string => String(value).padStart(2, "0");

export const formatWalletPasskeyLabel = (date: Date = new Date()): string => {
  const yy = String(date.getFullYear()).slice(-2);
  const mm = pad2(date.getMonth() + 1);
  const dd = pad2(date.getDate());
  const hh = pad2(date.getHours());
  const min = pad2(date.getMinutes());
  return `Nuri (${yy}-${mm}-${dd} ${hh}:${min})`;
};
