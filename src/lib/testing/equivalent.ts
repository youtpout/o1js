/**
 * helpers for testing equivalence of two implementations, one of them on bigints
 */
import { test, Random } from '../testing/property.js';
import { Provable } from '../provable.js';
import { deepEqual } from 'node:assert/strict';
import { Bool, Field } from '../core.js';

export {
  equivalent,
  equivalentProvable,
  equivalentAsync,
  oneOf,
  throwError,
  handleErrors,
  deepEqual as defaultAssertEqual,
  id,
};
export { field, bigintField, bool, boolean, unit };
export { Spec, ToSpec, FromSpec, SpecFromFunctions, ProvableSpec };

// a `Spec` tells us how to compare two functions

type FromSpec<In1, In2> = {
  // `rng` creates random inputs to the first function
  rng: Random<In1>;

  // `there` converts to inputs to the second function
  there: (x: In1) => In2;

  // `provable` tells us how to create witnesses, to test provable code
  // note: we only allow the second function to be provable;
  // the second because it's more natural to have non-provable types as random generator output
  provable?: Provable<In2>;
};

type ToSpec<Out1, Out2> = {
  // `back` converts outputs of the second function back to match the first function
  back: (x: Out2) => Out1;

  // `assertEqual` to compare outputs against each other; defaults to `deepEqual`
  assertEqual?: (x: Out1, y: Out1, message: string) => void;
};

type Spec<T1, T2> = FromSpec<T1, T2> & ToSpec<T1, T2>;

type ProvableSpec<T1, T2> = Spec<T1, T2> & { provable: Provable<T2> };

type FuncSpec<In1 extends Tuple<any>, Out1, In2 extends Tuple<any>, Out2> = {
  from: {
    [k in keyof In1]: k extends keyof In2 ? FromSpec<In1[k], In2[k]> : never;
  };
  to: ToSpec<Out1, Out2>;
};

type SpecFromFunctions<
  F1 extends AnyFunction,
  F2 extends AnyFunction
> = FuncSpec<Parameters<F1>, ReturnType<F1>, Parameters<F2>, ReturnType<F2>>;

function id<T>(x: T) {
  return x;
}

// unions of specs, to cleanly model function parameters that are unions of types

type FromSpecUnion<T1, T2> = {
  _isUnion: true;
  specs: Tuple<FromSpec<T1, T2>>;
  rng: Random<[number, T1]>;
};

type OrUnion<T1, T2> = FromSpec<T1, T2> | FromSpecUnion<T1, T2>;

type Union<T> = T[keyof T & number];

function oneOf<In extends Tuple<FromSpec<any, any>>>(
  ...specs: In
): FromSpecUnion<Union<Params1<In>>, Union<Params2<In>>> {
  // the randomly generated value from a union keeps track of which spec it came from
  let rng = Random.oneOf(
    ...specs.map((spec, i) =>
      Random.map(spec.rng, (x) => [i, x] as [number, any])
    )
  );
  return { _isUnion: true, specs, rng };
}

function toUnion<T1, T2>(spec: OrUnion<T1, T2>): FromSpecUnion<T1, T2> {
  let specAny = spec as any;
  return specAny._isUnion ? specAny : oneOf(specAny);
}

// equivalence tester

function equivalent<
  In extends Tuple<FromSpec<any, any>>,
  Out extends ToSpec<any, any>
>({ from, to }: { from: In; to: Out }) {
  return function run(
    f1: (...args: Params1<In>) => Result1<Out>,
    f2: (...args: Params2<In>) => Result2<Out>,
    label = 'expect equal results'
  ) {
    let generators = from.map((spec) => spec.rng);
    let assertEqual = to.assertEqual ?? deepEqual;
    test(...(generators as any[]), (...args) => {
      args.pop();
      let inputs = args as Params1<In>;
      handleErrors(
        () => f1(...inputs),
        () =>
          to.back(
            f2(...(inputs.map((x, i) => from[i].there(x)) as Params2<In>))
          ),
        (x, y) => assertEqual(x, y, label),
        label
      );
    });
  };
}

// async equivalence

function equivalentAsync<
  In extends Tuple<FromSpec<any, any>>,
  Out extends ToSpec<any, any>
>({ from, to }: { from: In; to: Out }, { runs = 1 } = {}) {
  return async function run(
    f1: (...args: Params1<In>) => Promise<Result1<Out>> | Result1<Out>,
    f2: (...args: Params2<In>) => Promise<Result2<Out>> | Result2<Out>,
    label = 'expect equal results'
  ) {
    let generators = from.map((spec) => spec.rng);
    let assertEqual = to.assertEqual ?? deepEqual;

    let nexts = generators.map((g) => g.create());

    for (let i = 0; i < runs; i++) {
      let args = nexts.map((next) => next());
      let inputs = args as Params1<In>;
      try {
        await handleErrorsAsync(
          () => f1(...inputs),
          async () =>
            to.back(
              await f2(
                ...(inputs.map((x, i) => from[i].there(x)) as Params2<In>)
              )
            ),
          (x, y) => assertEqual(x, y, label),
          label
        );
      } catch (err) {
        console.log(...inputs);
        throw err;
      }
    }
  };
}

// equivalence tester for provable code

function equivalentProvable<
  In extends Tuple<OrUnion<any, any>>,
  Out extends ToSpec<any, any>
>({ from: fromRaw, to }: { from: In; to: Out }) {
  let fromUnions = fromRaw.map(toUnion);
  return function run(
    f1: (...args: Params1<In>) => Result1<Out>,
    f2: (...args: Params2<In>) => Result2<Out>,
    label = 'expect equal results'
  ) {
    let generators = fromUnions.map((spec) => spec.rng);
    let assertEqual = to.assertEqual ?? deepEqual;
    test(...generators, (...args) => {
      args.pop();

      // figure out which spec to use for each argument
      let from = (args as [number, unknown][]).map(
        ([j], i) => fromUnions[i].specs[j]
      );
      let inputs = (args as [number, unknown][]).map(
        ([, x]) => x
      ) as Params1<In>;
      let inputs2 = inputs.map((x, i) => from[i].there(x)) as Params2<In>;

      // outside provable code
      handleErrors(
        () => f1(...inputs),
        () => f2(...inputs2),
        (x, y) => assertEqual(x, to.back(y), label),
        label
      );

      // inside provable code
      Provable.runAndCheck(() => {
        let inputWitnesses = inputs2.map((x, i) => {
          let provable = from[i].provable;
          return provable !== undefined
            ? Provable.witness(provable, () => x)
            : x;
        }) as Params2<In>;
        handleErrors(
          () => f1(...inputs),
          () => f2(...inputWitnesses),
          (x, y) => Provable.asProver(() => assertEqual(x, to.back(y), label))
        );
      });
    });
  };
}

// some useful specs

let unit: ToSpec<void, void> = { back: id, assertEqual() {} };

let field: ProvableSpec<bigint, Field> = {
  rng: Random.field,
  there: Field,
  back: (x) => x.toBigInt(),
  provable: Field,
};

let bigintField: Spec<bigint, bigint> = {
  rng: Random.field,
  there: id,
  back: id,
};

let bool: ProvableSpec<boolean, Bool> = {
  rng: Random.boolean,
  there: Bool,
  back: (x) => x.toBoolean(),
  provable: Bool,
};
let boolean: Spec<boolean, boolean> = {
  rng: Random.boolean,
  there: id,
  back: id,
};

// helper to ensure two functions throw equivalent errors

function handleErrors<T, S, R>(
  op1: () => T,
  op2: () => S,
  useResults?: (a: T, b: S) => R,
  label?: string
): R | undefined {
  let result1: T, result2: S;
  let error1: Error | undefined;
  let error2: Error | undefined;
  try {
    result1 = op1();
  } catch (err) {
    error1 = err as Error;
  }
  try {
    result2 = op2();
  } catch (err) {
    error2 = err as Error;
  }
  if (!!error1 !== !!error2) {
    error1 && console.log(error1);
    error2 && console.log(error2);
  }
  let message = `${(label && `${label}: `) || ''}equivalent errors`;
  deepEqual(!!error1, !!error2, message);
  if (!(error1 || error2) && useResults !== undefined) {
    return useResults(result1!, result2!);
  }
}

async function handleErrorsAsync<T, S, R>(
  op1: () => T,
  op2: () => S,
  useResults?: (a: Awaited<T>, b: Awaited<S>) => R,
  label?: string
): Promise<R | undefined> {
  let result1: Awaited<T>, result2: Awaited<S>;
  let error1: Error | undefined;
  let error2: Error | undefined;
  try {
    result1 = await op1();
  } catch (err) {
    error1 = err as Error;
  }
  try {
    result2 = await op2();
  } catch (err) {
    error2 = err as Error;
  }
  if (!!error1 !== !!error2) {
    error1 && console.log(error1);
    error2 && console.log(error2);
  }
  let message = `${(label && `${label}: `) || ''}equivalent errors`;
  deepEqual(!!error1, !!error2, message);
  if (!(error1 || error2) && useResults !== undefined) {
    return useResults(result1!, result2!);
  }
}

function throwError(message?: string): any {
  throw Error(message);
}

// helper types

type AnyFunction = (...args: any) => any;

type Tuple<T> = [] | [T, ...T[]];

// infer input types from specs

type Param1<In extends OrUnion<any, any>> = In extends {
  there: (x: infer In) => any;
}
  ? In
  : In extends FromSpecUnion<infer T1, any>
  ? T1
  : never;
type Param2<In extends OrUnion<any, any>> = In extends {
  there: (x: any) => infer In;
}
  ? In
  : In extends FromSpecUnion<any, infer T2>
  ? T2
  : never;

type Params1<Ins extends Tuple<OrUnion<any, any>>> = {
  [k in keyof Ins]: Param1<Ins[k]>;
};
type Params2<Ins extends Tuple<OrUnion<any, any>>> = {
  [k in keyof Ins]: Param2<Ins[k]>;
};

type Result1<Out extends ToSpec<any, any>> = Out extends ToSpec<infer Out1, any>
  ? Out1
  : never;
type Result2<Out extends ToSpec<any, any>> = Out extends ToSpec<any, infer Out2>
  ? Out2
  : never;