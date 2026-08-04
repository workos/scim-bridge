// @ts-nocheck — vendored from workos/packages/design-system by
// `npm run sync-design-system`, which overwrites this file. Edit it upstream.
import * as React from 'react';

// Creates a union type of string literals with strings, but retains intellisense for the literals.
// Union<string, 'foo' | 'bar'> => string | Omit<string, 'foo' | 'bar'>
type Union<S = string, T extends string | number = string> = T | Omit<S, T>;

const breakpointsArray = ['initial', 'xs', 'sm', 'md', 'lg', 'xl'] as const;
const breakpoints = new Set(breakpointsArray);
type Breakpoint = typeof breakpoints extends Set<infer B> ? B : never;
type Responsive<T> = T | Partial<Record<Breakpoint, T>>;

type BooleanPropDef = {
  type: 'boolean';
  default?: boolean;
  required?: boolean;
  className?: string;
};
type StringPropDef = {
  type: 'string';
  default?: string;
  required?: boolean;
};
type ReactNodePropDef = {
  type: 'ReactNode';
  default?: React.ReactNode;
  required?: boolean;
};
type EnumPropDef<T extends string> = {
  type: 'enum';
  values: readonly T[];
  default?: T;
  required?: boolean;
};
type EnumOrStringPropDef<T extends string> = {
  type: 'enum | string';
  values: readonly T[];
  default?: T | string;
  required?: boolean;
};

type NonStylingPropDef = {
  className?: never;
  customProperties?: never;
  parseValue?: never;
};

type StylingPropDef = {
  className: string;
  parseValue?: (value: string) => string | undefined;
};

type ArbitraryStylingPropDef = {
  className: string;
  customProperties: `--${string}`[];
  parseValue?: (value: string) => string | undefined;
};

type RegularPropDef<T> =
  | ReactNodePropDef
  | BooleanPropDef
  | (StringPropDef & ArbitraryStylingPropDef)
  | (StringPropDef & NonStylingPropDef)
  | (EnumPropDef<T extends string ? T : string> & StylingPropDef)
  | (EnumPropDef<T extends string ? T : string> & NonStylingPropDef)
  | (EnumOrStringPropDef<T extends string ? T : string> &
      ArbitraryStylingPropDef)
  | (EnumOrStringPropDef<T extends string ? T : string> & NonStylingPropDef);
type ResponsivePropDef<T = unknown> = RegularPropDef<T> & { responsive: true };
type PropDef<T = unknown> = RegularPropDef<T> | ResponsivePropDef<T>;

// prettier-ignore
type GetPropDefType<Def> =
    Def extends BooleanPropDef ? (Def extends ResponsivePropDef ? Responsive<boolean> : boolean)
  : Def extends StringPropDef ? (Def extends ResponsivePropDef ? Responsive<string> : string)
  : Def extends ReactNodePropDef ? (Def extends ResponsivePropDef ? Responsive<React.ReactNode> : React.ReactNode)
  : Def extends EnumOrStringPropDef<infer Type> ?
    Def extends ResponsivePropDef<infer Type extends string> ? Responsive<Union<string, Type>> : Type
  : Def extends EnumPropDef<infer Type> ? (Def extends ResponsivePropDef<infer Type> ? Responsive<Type> : Type)
  : never;

type GetPropDefTypes<P> = {
  [K in keyof P]?: GetPropDefType<P[K]>;
};

export { breakpoints, breakpointsArray };
export type {
  //
  Breakpoint,
  GetPropDefTypes,
  PropDef,
  Responsive,
  ResponsivePropDef,
  Union,
};
