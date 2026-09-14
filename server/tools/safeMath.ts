// Tiny hand-written arithmetic expression evaluator — no eval/Function.
// Grammar (standard precedence, ^ right-associative, unary +/-):
//   expression := term (('+'|'-') term)*
//   term       := power (('*'|'/'|'%') power)*
//   power      := unary ('^' power)?
//   unary      := ('+'|'-')? primary
//   primary    := number | identifier ('(' args ')')? | '(' expression ')'
//   args       := expression (',' expression)*

type TokenType = "number" | "identifier" | "op" | "lparen" | "rparen" | "comma" | "eof";
interface Token {
  type: TokenType;
  value: string;
}

const FUNCTIONS: Record<string, (...args: number[]) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  sqrt: Math.sqrt,
  abs: Math.abs,
  exp: Math.exp,
  log: Math.log,
  log10: Math.log10,
  log2: Math.log2,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  min: (...a) => Math.min(...a),
  max: (...a) => Math.max(...a),
  pow: (a, b) => Math.pow(a, b),
};

const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };

function readNumber(input: string, start: number): { value: string; end: number } {
  let i = start;
  while (i < input.length && /[0-9]/.test(input[i]!)) i++;
  if (input[i] === ".") {
    i++;
    while (i < input.length && /[0-9]/.test(input[i]!)) i++;
  }
  if (input[i] === "e" || input[i] === "E") {
    let j = i + 1;
    if (input[j] === "+" || input[j] === "-") j++;
    if (/[0-9]/.test(input[j] ?? "")) {
      i = j;
      while (i < input.length && /[0-9]/.test(input[i]!)) i++;
    }
  }
  return { value: input.slice(start, i), end: i };
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      const { value, end } = readNumber(input, i);
      if (!value || value === "." || Number.isNaN(Number(value))) {
        throw new Error(`Invalid number near position ${i}`);
      }
      tokens.push({ type: "number", value });
      i = end;
      continue;
    }
    if (/[a-zA-Z_]/.test(ch)) {
      let j = i + 1;
      while (j < input.length && /[a-zA-Z0-9_]/.test(input[j]!)) j++;
      tokens.push({ type: "identifier", value: input.slice(i, j) });
      i = j;
      continue;
    }
    if ("+-*/%^".includes(ch)) {
      tokens.push({ type: "op", value: ch });
      i++;
      continue;
    }
    if (ch === "(") {
      tokens.push({ type: "lparen", value: ch });
      i++;
      continue;
    }
    if (ch === ")") {
      tokens.push({ type: "rparen", value: ch });
      i++;
      continue;
    }
    if (ch === ",") {
      tokens.push({ type: "comma", value: ch });
      i++;
      continue;
    }
    throw new Error(`Unexpected character "${ch}" at position ${i}`);
  }
  tokens.push({ type: "eof", value: "" });
  return tokens;
}

class Parser {
  private pos = 0;
  constructor(private tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    return this.tokens[this.pos++]!;
  }

  private expect(type: TokenType): Token {
    const t = this.next();
    if (t.type !== type) throw new Error(`Expected ${type} but got "${t.value || t.type}"`);
    return t;
  }

  parse(): number {
    const value = this.parseExpression();
    this.expect("eof");
    return value;
  }

  private parseExpression(): number {
    let value = this.parseTerm();
    for (;;) {
      const t = this.peek();
      if (t.type === "op" && (t.value === "+" || t.value === "-")) {
        this.next();
        const rhs = this.parseTerm();
        value = t.value === "+" ? value + rhs : value - rhs;
      } else break;
    }
    return value;
  }

  private parseTerm(): number {
    let value = this.parsePower();
    for (;;) {
      const t = this.peek();
      if (t.type === "op" && (t.value === "*" || t.value === "/" || t.value === "%")) {
        this.next();
        const rhs = this.parsePower();
        if (t.value === "*") value = value * rhs;
        else if (t.value === "/") {
          if (rhs === 0) throw new Error("Division by zero");
          value = value / rhs;
        } else {
          value = value % rhs;
        }
      } else break;
    }
    return value;
  }

  private parsePower(): number {
    const base = this.parseUnary();
    const t = this.peek();
    if (t.type === "op" && t.value === "^") {
      this.next();
      const exponent = this.parsePower(); // right-associative
      return Math.pow(base, exponent);
    }
    return base;
  }

  private parseUnary(): number {
    const t = this.peek();
    if (t.type === "op" && (t.value === "+" || t.value === "-")) {
      this.next();
      const value = this.parseUnary();
      return t.value === "-" ? -value : value;
    }
    return this.parsePrimary();
  }

  private parsePrimary(): number {
    const t = this.peek();
    if (t.type === "number") {
      this.next();
      return Number(t.value);
    }
    if (t.type === "lparen") {
      this.next();
      const value = this.parseExpression();
      this.expect("rparen");
      return value;
    }
    if (t.type === "identifier") {
      this.next();
      const name = t.value.toLowerCase();
      if (this.peek().type === "lparen") {
        this.next();
        const args: number[] = [];
        if (this.peek().type !== "rparen") {
          args.push(this.parseExpression());
          while (this.peek().type === "comma") {
            this.next();
            args.push(this.parseExpression());
          }
        }
        this.expect("rparen");
        const fn = FUNCTIONS[name];
        if (!fn) throw new Error(`Unknown function: ${name}`);
        return fn(...args);
      }
      const constant = CONSTANTS[name];
      if (constant === undefined) throw new Error(`Unknown identifier: ${name}`);
      return constant;
    }
    throw new Error(`Unexpected token: "${t.value || t.type}"`);
  }
}

export function evaluateExpression(input: unknown): number {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new Error("expression must be a non-empty string");
  }
  if (input.length > 500) throw new Error("expression too long (max 500 chars)");
  const tokens = tokenize(input);
  const parser = new Parser(tokens);
  const result = parser.parse();
  if (!Number.isFinite(result)) throw new Error("result is not a finite number");
  return result;
}
