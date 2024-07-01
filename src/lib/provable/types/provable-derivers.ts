import { Provable, ProvablePure } from './provable-intf.js';
import type { Field } from '../wrapped.js';
import {
  createDerivers,
  NonMethods,
  InferProvable as GenericInferProvable,
  InferJson,
  InferredProvable as GenericInferredProvable,
  IsPure as GenericIsPure,
  NestedProvable as GenericNestedProvable,
  createHashInput,
  Constructor,
  InferValue,
  InferJsonNested,
  InferValueNested,
  InferProvableNested,
} from '../../../bindings/lib/provable-generic.js';
import { Tuple } from '../../util/types.js';
import { GenericHashInput } from '../../../bindings/lib/generic.js';

// external API
export {
  ProvableExtended,
  provable,
  provablePure,
  provableTuple,
  provableFromClass,
  provableMap,
};

// internal API
export {
  NonMethods,
  HashInput,
  InferProvable,
  InferJson,
  InferredProvable,
  IsPure,
  NestedProvable,
};

type ProvableExtension<T, TJson = any> = {
  toInput: (x: T) => { fields?: Field[]; packed?: [Field, number][] };
  toJSON: (x: T) => TJson;
  fromJSON: (x: TJson) => T;
  empty: () => T;
};
type ProvableExtended<T, TValue = any, TJson = any> = Provable<T, TValue> &
  ProvableExtension<T, TJson>;
type ProvablePureExtended<T, TValue = any, TJson = any> = ProvablePure<
  T,
  TValue
> &
  ProvableExtension<T, TJson>;

type InferProvable<T> = GenericInferProvable<T, Field>;
type InferredProvable<T> = GenericInferredProvable<T, Field>;
type IsPure<T> = GenericIsPure<T, Field>;

type HashInput = GenericHashInput<Field>;
const HashInput = createHashInput<Field>();

type NestedProvable = GenericNestedProvable<Field>;

const { provable } = createDerivers<Field>();

function provablePure<A>(
  typeObj: A
): ProvablePureExtended<InferProvable<A>, InferValue<A>, InferJson<A>> {
  return provable(typeObj, { isPure: true }) as any;
}

function provableTuple<T extends Tuple<any>>(types: T): InferredProvable<T> {
  return provable(types) as any;
}

function provableFromClass<
  A extends NestedProvable,
  T extends InferProvableNested<Field, A>,
  V extends InferValueNested<Field, A>,
  J extends InferJsonNested<Field, A>
>(
  Class: Constructor<T> & { check?: (x: T) => void; empty?: () => T },
  typeObj: A
): IsPure<A> extends true
  ? ProvablePureExtended<T, V, J>
  : ProvableExtended<T, V, J> {
  let raw: ProvableExtended<T, V, J> = provable(typeObj) as any;
  return {
    sizeInFields: raw.sizeInFields,
    toFields: raw.toFields,
    toAuxiliary: raw.toAuxiliary,
    fromFields(fields, aux) {
      return construct(Class, raw.fromFields(fields, aux));
    },
    check(value) {
      if (Class.check !== undefined) {
        Class.check(value);
      } else {
        raw.check(value);
      }
    },
    toValue: raw.toValue,
    fromValue(x) {
      return construct(Class, raw.fromValue(x));
    },
    toInput: raw.toInput,
    toJSON: raw.toJSON,
    fromJSON(x) {
      return construct(Class, raw.fromJSON(x));
    },
    empty() {
      return Class.empty !== undefined
        ? Class.empty()
        : construct(Class, raw.empty());
    },
  } satisfies ProvableExtended<T, V, J> as any;
}

function construct<Raw, T extends Raw>(Class: Constructor<T>, value: Raw): T {
  let instance = Object.create(Class.prototype);
  return Object.assign(instance, value);
}

function provableMap<
  A extends Provable<any>,
  S,
  T extends InferProvable<A> = InferProvable<A>
>(base: A, there: (t: T) => S, back: (s: S) => T): Provable<S, InferValue<A>> {
  return {
    sizeInFields() {
      return base.sizeInFields();
    },
    toFields(value) {
      return base.toFields(back(value));
    },
    toAuxiliary(value) {
      return base.toAuxiliary(value === undefined ? undefined : back(value));
    },
    fromFields(fields, aux) {
      return there(base.fromFields(fields, aux));
    },
    check(value) {
      base.check(back(value));
    },
    toValue(value) {
      return base.toValue(back(value));
    },
    fromValue(value) {
      return there(base.fromValue(value));
    },
  };
}
