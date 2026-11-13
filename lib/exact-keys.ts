/**
 * Every key of T, each a real key of T and none left out, checked by the compiler.
 *
 * A reader that takes a stored row apart field by field lists the fields it
 * checks as strings. Written through this, a field renamed in T, added to T or
 * misspelled in the list fails to compile where it is read, instead of making
 * every stored row read as broken or letting an unchecked field through.
 *
 *     const ROW_KEYS = exactKeys<Row>()(["id", "state"]);
 */
export function exactKeys<T>() {
  return <const K extends readonly (keyof T & string)[]>(
    keys: K & ([Exclude<keyof T, K[number]>] extends [never] ? unknown : { missing: Exclude<keyof T, K[number]> }),
  ): K => keys;
}
