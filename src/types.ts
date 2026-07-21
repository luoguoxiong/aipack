export type Json = string | number | boolean | null | JsonObject | JsonArray;
export interface JsonObject {
  [key: string]: Json;
}
export interface JsonArray extends Array<Json> {}

export type LiteralUnion<T extends U, U = string> = T | (U & {});

export interface RecordLike {
  [key: string]: unknown;
}
