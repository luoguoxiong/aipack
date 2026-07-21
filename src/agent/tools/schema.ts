import { Schema } from './base.js';

export class StringSchema implements Schema {
  private _description: string;
  private _minLength: number | null;
  private _maxLength: number | null;
  private _enum: readonly unknown[] | null;
  private _nullable: boolean;

  constructor(
    description: string = '',
    options?: {
      min_length?: number;
      max_length?: number;
      enum?: readonly unknown[];
      nullable?: boolean;
    },
  ) {
    this._description = description;
    this._minLength = options?.min_length ?? null;
    this._maxLength = options?.max_length ?? null;
    this._enum = options?.enum ? [...options.enum] : null;
    this._nullable = options?.nullable ?? false;
  }

  toJsonSchema(): Record<string, unknown> {
    const type: string | string[] = this._nullable ? ['string', 'null'] : 'string';
    const schema: Record<string, unknown> = { type };

    if (this._description) schema.description = this._description;
    if (this._minLength !== null) schema.minLength = this._minLength;
    if (this._maxLength !== null) schema.maxLength = this._maxLength;
    if (this._enum !== null) schema.enum = [...this._enum];

    return schema;
  }
}

export class IntegerSchema implements Schema {
  private _value: number;
  private _description: string;
  private _minimum: number | null;
  private _maximum: number | null;
  private _enum: readonly number[] | null;
  private _nullable: boolean;

  constructor(
    value: number = 0,
    options?: {
      description?: string;
      minimum?: number;
      maximum?: number;
      enum?: readonly number[];
      nullable?: boolean;
    },
  ) {
    this._value = value;
    this._description = options?.description ?? '';
    this._minimum = options?.minimum ?? null;
    this._maximum = options?.maximum ?? null;
    this._enum = options?.enum ? [...options.enum] : null;
    this._nullable = options?.nullable ?? false;
  }

  toJsonSchema(): Record<string, unknown> {
    const type: string | string[] = this._nullable ? ['integer', 'null'] : 'integer';
    const schema: Record<string, unknown> = { type };

    if (this._description) schema.description = this._description;
    if (this._minimum !== null) schema.minimum = this._minimum;
    if (this._maximum !== null) schema.maximum = this._maximum;
    if (this._enum !== null) schema.enum = [...this._enum];

    return schema;
  }
}

export class NumberSchema implements Schema {
  private _value: number;
  private _description: string;
  private _minimum: number | null;
  private _maximum: number | null;
  private _enum: readonly number[] | null;
  private _nullable: boolean;

  constructor(
    value: number = 0,
    options?: {
      description?: string;
      minimum?: number;
      maximum?: number;
      enum?: readonly number[];
      nullable?: boolean;
    },
  ) {
    this._value = value;
    this._description = options?.description ?? '';
    this._minimum = options?.minimum ?? null;
    this._maximum = options?.maximum ?? null;
    this._enum = options?.enum ? [...options.enum] : null;
    this._nullable = options?.nullable ?? false;
  }

  toJsonSchema(): Record<string, unknown> {
    const type: string | string[] = this._nullable ? ['number', 'null'] : 'number';
    const schema: Record<string, unknown> = { type };

    if (this._description) schema.description = this._description;
    if (this._minimum !== null) schema.minimum = this._minimum;
    if (this._maximum !== null) schema.maximum = this._maximum;
    if (this._enum !== null) schema.enum = [...this._enum];

    return schema;
  }
}

export class BooleanSchema implements Schema {
  private _description: string;
  private _default: boolean | null;
  private _nullable: boolean;

  constructor(options?: {
    description?: string;
    default?: boolean;
    nullable?: boolean;
  }) {
    this._description = options?.description ?? '';
    this._default = options?.default ?? null;
    this._nullable = options?.nullable ?? false;
  }

  toJsonSchema(): Record<string, unknown> {
    const type: string | string[] = this._nullable ? ['boolean', 'null'] : 'boolean';
    const schema: Record<string, unknown> = { type };

    if (this._description) schema.description = this._description;
    if (this._default !== null) schema.default = this._default;

    return schema;
  }
}

export class ArraySchema implements Schema {
  private _itemsSchema: Schema;
  private _description: string;
  private _minItems: number | null;
  private _maxItems: number | null;
  private _nullable: boolean;

  constructor(
    items?: Schema,
    options?: {
      description?: string;
      min_items?: number;
      max_items?: number;
      nullable?: boolean;
    },
  ) {
    this._itemsSchema = items || new StringSchema('');
    this._description = options?.description ?? '';
    this._minItems = options?.min_items ?? null;
    this._maxItems = options?.max_items ?? null;
    this._nullable = options?.nullable ?? false;
  }

  toJsonSchema(): Record<string, unknown> {
    const type: string | string[] = this._nullable ? ['array', 'null'] : 'array';
    const schema: Record<string, unknown> = {
      type,
      items: Schema.fragment(this._itemsSchema),
    };

    if (this._description) schema.description = this._description;
    if (this._minItems !== null) schema.minItems = this._minItems;
    if (this._maxItems !== null) schema.maxItems = this._maxItems;

    return schema;
  }
}

export class ObjectSchema implements Schema {
  private _properties: Record<string, unknown>;
  private _required: string[];
  private _rootDescription: string;
  private _additionalProperties: boolean | Record<string, unknown> | null;
  private _nullable: boolean;

  constructor(
    properties?: Record<string, unknown>,
    options?: {
      required?: string[];
      description?: string;
      additional_properties?: boolean | Record<string, unknown>;
      nullable?: boolean;
    },
  ) {
    this._properties = { ...properties };
    this._required = [...(options?.required || [])];
    this._rootDescription = options?.description ?? '';
    this._additionalProperties = options?.additional_properties ?? null;
    this._nullable = options?.nullable ?? false;
  }

  toJsonSchema(): Record<string, unknown> {
    const type: string | string[] = this._nullable ? ['object', 'null'] : 'object';
    const props: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(this._properties)) {
      props[key] = Schema.fragment(value);
    }

    const schema: Record<string, unknown> = { type, properties: props };

    if (this._required.length) schema.required = [...this._required];
    if (this._rootDescription) schema.description = this._rootDescription;
    if (this._additionalProperties !== null) schema.additionalProperties = this._additionalProperties;

    return schema;
  }
}

export function toolParametersSchema(
  options?: {
    required?: string[];
    description?: string;
    additional_properties?: boolean | Record<string, unknown>;
  },
  ...properties: Record<string, unknown>[]
): Record<string, unknown> {
  const mergedProps: Record<string, unknown> = {};
  for (const props of properties) {
    Object.assign(mergedProps, props);
  }

  return new ObjectSchema(mergedProps, {
    required: options?.required,
    description: options?.description,
    additional_properties: options?.additional_properties ?? false,
  }).toJsonSchema();
}