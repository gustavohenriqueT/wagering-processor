import type { SqlEntityManager } from '@mikro-orm/postgresql';

export type Row = Record<string, unknown>;

export class SqlDb {
  constructor(private readonly em: SqlEntityManager) {}

  async query(sql: string, params: unknown[] = []): Promise<Row[]> {
    return (await this.em.execute(sql, params)) as Row[];
  }

  async exec(sql: string, params: unknown[] = []): Promise<number> {
    const result = (await this.em.execute(sql, params, 'run')) as { affectedRows?: number };
    return result.affectedRows ?? 0;
  }
}

export const iso = (column: string): string =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') {
    throw new Error(`coluna ${key}: esperado texto, veio ${typeof value}`);
  }
  return value;
}

export function optionalText(row: Row, key: string): string | undefined {
  return row[key] === null || row[key] === undefined ? undefined : text(row, key);
}

export function int(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== 'number') {
    throw new Error(`coluna ${key}: esperado número, veio ${typeof value}`);
  }
  return value;
}

export function date(row: Row, key: string): Date {
  return new Date(text(row, key));
}

export function optionalDate(row: Row, key: string): Date | undefined {
  const value = optionalText(row, key);
  return value === undefined ? undefined : new Date(value);
}

export function enumValue<E extends string>(enumObject: Record<string, E>, value: string, name: string): E {
  const found = Object.values(enumObject).find((candidate) => candidate === value);
  if (found === undefined) {
    throw new Error(`valor inesperado para ${name}: ${value}`);
  }
  return found;
}