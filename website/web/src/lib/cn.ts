import clsx, { type ClassValue } from 'clsx';

/** 组合 className，条件写法更简洁。 */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}
