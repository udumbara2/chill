import type {
  ConditionExpression,
  BasicConditionExpression,
  LogicalOperatorExpression,
  GroupExpression
} from '../types/edge'
import { OperatorType as OpType, LogicalOperatorType as LogOpType, ExpressionType as ExprType } from '../types/edge'

interface Token {
  type: 'field' | 'operator' | 'value' | 'logical' | 'paren' | 'string' | 'number' | 'boolean'
  value: string
}

class ExpressionParser {
  private tokens: Token[] = []
  private pos = 0

  parse(input: string): ConditionExpression {
    this.tokens = this.tokenize(input)
    this.pos = 0
    return this.parseExpression()
  }

  private tokenize(input: string): Token[] {
    const tokens: Token[] = []
    let i = 0

    while (i < input.length) {
      const char = input[i]

      if (/\s/.test(char)) {
        i++
        continue
      }

      if (char === '(' || char === ')') {
        tokens.push({ type: 'paren', value: char })
        i++
        continue
      }

      if (char === '"') {
        let str = ''
        i++
        while (i < input.length && input[i] !== '"') {
          str += input[i]
          i++
        }
        i++
        tokens.push({ type: 'string', value: str })
        continue
      }

      if (char === "'") {
        let str = ''
        i++
        while (i < input.length && input[i] !== "'") {
          str += input[i]
          i++
        }
        i++
        tokens.push({ type: 'string', value: str })
        continue
      }

      if (/[0-9]/.test(char)) {
        let num = ''
        while (i < input.length && /[0-9.]/.test(input[i])) {
          num += input[i]
          i++
        }
        tokens.push({ type: 'number', value: num })
        continue
      }

      if (/[a-zA-Z_]/.test(char)) {
        let word = ''
        while (i < input.length && /[a-zA-Z0-9_]/.test(input[i])) {
          word += input[i]
          i++
        }

        const upperWord = word.toUpperCase()
        if (upperWord === 'AND' || upperWord === 'OR' || upperWord === 'NOT') {
          tokens.push({ type: 'logical', value: upperWord })
        } else if (upperWord === 'TRUE' || upperWord === 'FALSE') {
          tokens.push({ type: 'boolean', value: upperWord })
        } else {
          tokens.push({ type: 'field', value: word })
        }
        continue
      }

      if (char === '=' || char === '!' || char === '>' || char === '<') {
        let op = char
        i++
        if (i < input.length && input[i] === '=') {
          op += '='
          i++
        }
        tokens.push({ type: 'operator', value: op })
        continue
      }

      i++
    }

    return tokens
  }

  private peek(): Token | null {
    if (this.pos >= this.tokens.length) return null
    return this.tokens[this.pos]
  }

  private consume(): Token | null {
    if (this.pos >= this.tokens.length) return null
    return this.tokens[this.pos++]
  }

  private parseExpression(): ConditionExpression {
    return this.parseOr()
  }

  private parseOr(): ConditionExpression {
    let left = this.parseAnd()

    while (this.peek()?.type === 'logical' && this.peek()?.value === 'OR') {
      this.consume()
      const right = this.parseAnd()
      const logicalExpression: LogicalOperatorExpression = {
        type: ExprType.LOGICAL,
        operator: LogOpType.OR,
        left,
        right
      }
      left = logicalExpression
    }

    return left
  }

  private parseAnd(): ConditionExpression {
    let left = this.parseNot()

    while (this.peek()?.type === 'logical' && this.peek()?.value === 'AND') {
      this.consume()
      const right = this.parseNot()
      const logicalExpression: LogicalOperatorExpression = {
        type: ExprType.LOGICAL,
        operator: LogOpType.AND,
        left,
        right
      }
      left = logicalExpression
    }

    return left
  }

  private parseNot(): ConditionExpression {
    if (this.peek()?.type === 'logical' && this.peek()?.value === 'NOT') {
      this.consume()
      const expression = this.parseNot()
      const logicalExpression: LogicalOperatorExpression = {
        type: ExprType.LOGICAL,
        operator: LogOpType.NOT,
        left: expression,
        right: expression
      }
      return logicalExpression
    }

    return this.parseBasicOrGroup()
  }

  private parseBasicOrGroup(): ConditionExpression {
    const token = this.peek()

    if (token?.type === 'paren' && token.value === '(') {
      this.consume()
      const expression = this.parseExpression()
      const closingParen = this.peek()
      if (closingParen?.type !== 'paren' || closingParen.value !== ')') {
        throw new Error('Expected closing parenthesis')
      }
      this.consume()
      const groupExpression: GroupExpression = {
        type: ExprType.GROUP,
        expression
      }
      return groupExpression
    }

    return this.parseBasic()
  }

  private parseBasic(): BasicConditionExpression {
    const fieldToken = this.peek()
    if (fieldToken?.type !== 'field') {
      throw new Error('Expected field name')
    }
    const field = this.consume()!.value

    const opToken = this.peek()
    if (opToken?.type !== 'operator') {
      throw new Error('Expected operator')
    }
    const operator = this.parseOperator(opToken.value)
    this.consume()

    const valueToken = this.peek()
    if (!valueToken) {
      throw new Error('Expected value')
    }

    let value: string | number | boolean
    if (valueToken.type === 'string') {
      value = this.consume()!.value
    } else if (valueToken.type === 'number') {
      value = parseFloat(this.consume()!.value)
    } else if (valueToken.type === 'boolean') {
      value = this.consume()!.value === 'TRUE'
    } else if (valueToken.type === 'field') {
      value = this.consume()!.value
    } else {
      throw new Error('Expected string, number, boolean, or field name')
    }

    return {
      type: ExprType.BASIC,
      field,
      operator,
      value
    }
  }

  private parseOperator(op: string): OpType {
    switch (op) {
      case '==':
        return OpType.EQ
      case '!=':
        return OpType.NE
      case '>':
        return OpType.GT
      case '<':
        return OpType.LT
      case '>=':
        return OpType.GTE
      case '<=':
        return OpType.LTE
      default:
        throw new Error(`Unknown operator: ${op}`)
    }
  }
}

export function parseExpression(input: string): ConditionExpression {
  const parser = new ExpressionParser()
  return parser.parse(input)
}

export function evaluateExpression(expression: ConditionExpression, state: any): boolean {
  switch (expression.type) {
    case ExprType.BASIC:
      return evaluateBasicExpression(expression, state)

    case ExprType.LOGICAL:
      return evaluateLogicalExpression(expression, state)

    case ExprType.GROUP:
      return evaluateExpression(expression.expression, state)
  }
}

function evaluateBasicExpression(expression: BasicConditionExpression, state: any): boolean {
  const fieldValue = (state as any)[expression.field]

  if (fieldValue === undefined || fieldValue === null) {
    return false
  }

  const value = expression.value

  switch (expression.operator) {
    case OpType.EQ:
      return fieldValue === value
    case OpType.NE:
      return fieldValue !== value
    case OpType.GT:
      return typeof fieldValue === 'number' && typeof value === 'number' && fieldValue > value
    case OpType.LT:
      return typeof fieldValue === 'number' && typeof value === 'number' && fieldValue < value
    case OpType.GTE:
      return typeof fieldValue === 'number' && typeof value === 'number' && fieldValue >= value
    case OpType.LTE:
      return typeof fieldValue === 'number' && typeof value === 'number' && fieldValue <= value
    case OpType.CONTAINS:
      return String(fieldValue).includes(String(value))
    default:
      throw new Error(`Unknown operator: ${expression.operator}`)
  }
}

function evaluateLogicalExpression(expression: LogicalOperatorExpression, state: any): boolean {
  const leftResult = evaluateExpression(expression.left, state)

  switch (expression.operator) {
    case LogOpType.AND:
      return leftResult && evaluateExpression(expression.right, state)

    case LogOpType.OR:
      return leftResult || evaluateExpression(expression.right, state)

    case LogOpType.NOT:
      return !leftResult

    default:
      throw new Error(`Unknown logical operator: ${expression.operator}`)
  }
}
