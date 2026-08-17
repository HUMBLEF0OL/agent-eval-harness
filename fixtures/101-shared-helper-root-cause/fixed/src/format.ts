function pad(s: string, width: number): string {
  let out = s;
  while (out.length < width) {
    out += " ";
  }
  return out;
}

export function label(name: string, width: number): string {
  return pad(name + ":", width);
}

export function heading(text: string, width: number): string {
  return pad(text.toUpperCase(), width);
}

export function cell(value: string | number, width: number): string {
  return pad(String(value), width);
}
