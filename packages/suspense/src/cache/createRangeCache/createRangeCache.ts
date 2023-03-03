import {
  configure as configureIntervalUtilities,
  Interval,
} from "interval-utilities";

import {
  STATUS_PENDING,
  STATUS_REJECTED,
  STATUS_RESOLVED,
} from "../../constants";
import {
  RangeCacheLoadOptions,
  ComparisonFunction,
  GetPointForValue,
  PendingRecord,
  RangeCache,
  Record,
  Thenable,
} from "../../types";
import { assertPendingRecord } from "../../utils/assertPendingRecord";
import { createDeferred } from "../../utils/createDeferred";
import { defaultGetKey } from "../../utils/defaultGetKey";
import { isPendingRecord } from "../../utils/isPendingRecord";
import { findRanges } from "./findRanges";
import { findIndex, findNearestIndexAfter } from "./findIndex";
import { sliceValues } from "./sliceValues";

// Enable to help with debugging in dev
const DEBUG_LOG_IN_DEV = false;

type SerializableToString = { toString(): string };

type PendingRangeAndThenableTuple<Point, Value> = [
  Interval<Point>,
  Value[] | Thenable<Value[]>
];

type RangeMetadata<Point, Value> = {
  loadedRanges: Interval<Point>[];
  pendingRangeAndThenableTuples: PendingRangeAndThenableTuple<Point, Value>[];
  pendingRecords: Set<Record<Value[]>>;
  recordMap: Map<string, Record<Value[]>>;
  sortedValues: Value[];
};

export function createRangeCache<
  Point extends SerializableToString,
  Params extends Array<any>,
  Value
>(options: {
  comparePoints?: ComparisonFunction<Point>;
  debugLabel?: string;
  getKey?: (...params: Params) => string;
  getPointForValue: GetPointForValue<Point, Value>;
  load: (
    start: Point,
    end: Point,
    ...params: [...Params, RangeCacheLoadOptions]
  ) => Thenable<Value[]> | Value[];
}): RangeCache<Point, Params, Value> {
  const {
    comparePoints = defaultComparePoints,
    debugLabel,
    getKey = defaultGetKey,
    getPointForValue,
    load,
  } = options;

  const rangeUtils = configureIntervalUtilities<Point>(comparePoints);

  const rangeMap = new Map<string, RangeMetadata<Point, Value>>();

  const debugLogInDev = (debug: string, params?: Params, ...args: any[]) => {
    if (DEBUG_LOG_IN_DEV && process.env.NODE_ENV === "development") {
      const cacheKey = params ? `"${getKey(...params)}"` : "";
      const prefix = debugLabel
        ? `createRangeCache[${debugLabel}]`
        : "createRangeCache";

      console.log(
        `%c${prefix}`,
        "font-weight: bold; color: yellow;",
        debug,
        cacheKey,
        ...args
      );
    }
  };

  debugLogInDev("Creating cache ...");

  function abort(...params: Params): boolean {
    const cacheKey = getKey(...params);

    let caught;

    let rangeMetadata = rangeMap.get(cacheKey);
    if (rangeMetadata) {
      const { pendingRecords } = rangeMetadata;
      if (pendingRecords.size > 0) {
        debugLogInDev("abort()", params);

        for (let record of pendingRecords) {
          try {
            record.value.abortController.abort();
          } catch (error) {
            caught = error;
          }
        }
        pendingRecords.clear();

        if (caught !== undefined) {
          throw caught;
        }

        return true;
      }
    }

    return false;
  }

  function evict(...params: Params): boolean {
    debugLogInDev("evict()", params);

    const cacheKey = getKey(...params);

    return rangeMap.delete(cacheKey);
  }

  function evictAll(): boolean {
    debugLogInDev(`evictAll()`, undefined, `${rangeMap.size} records`);

    const hadValues = rangeMap.size > 0;

    rangeMap.clear();

    return hadValues;
  }

  function fetchAsync(
    start: Point,
    end: Point,
    ...params: Params
  ): Thenable<Value[]> | Value[] {
    const record = getOrCreateRecord(start, end, ...params);
    switch (record.status) {
      case STATUS_PENDING:
        return record.value.deferred;
      case STATUS_RESOLVED:
        return record.value;
      case STATUS_REJECTED:
        throw record.value;
    }
  }

  function fetchSuspense(start: Point, end: Point, ...params: Params): Value[] {
    const record = getOrCreateRecord(start, end, ...params);
    if (record.status === STATUS_RESOLVED) {
      return record.value;
    } else if (isPendingRecord(record)) {
      throw record.value.deferred;
    } else {
      throw record.value;
    }
  }

  function getOrCreateRangeMetadata(
    ...params: Params
  ): RangeMetadata<Point, Value> {
    const cacheKey = getKey(...params);
    let range = rangeMap.get(cacheKey);
    if (range == null) {
      range = {
        loadedRanges: [],
        pendingRangeAndThenableTuples: [],
        pendingRecords: new Set(),
        recordMap: new Map(),
        sortedValues: [],
      };

      rangeMap.set(cacheKey, range);
    }
    return range;
  }

  function getOrCreateRecord(
    start: Point,
    end: Point,
    ...params: Params
  ): Record<Value[]> {
    const rangeMetadata = getOrCreateRangeMetadata(...params);
    const cacheKey = `${start}–${end}`;

    let record = rangeMetadata.recordMap.get(cacheKey);
    if (record == null) {
      const abortController = new AbortController();
      const deferred = createDeferred<Value[]>(
        debugLabel ? `${debugLabel}: ${cacheKey}` : `${cacheKey}`
      );

      record = {
        status: STATUS_PENDING,
        value: {
          abortController,
          deferred,
        },
      } as Record<Value[]>;

      rangeMetadata.recordMap.set(cacheKey, record);

      processPendingRecord(
        rangeMetadata,
        record as PendingRecord<Value[]>,
        start,
        end,
        ...params
      );
    }

    return record;
  }

  async function processPendingRangeAndThenableTuple(
    rangeMetadata: RangeMetadata<Point, Value>,
    pendingRangeAndThenableTuple: PendingRangeAndThenableTuple<Point, Value>,
    start: Point,
    end: Point,
    ...params: Params
  ) {
    const [range, thenable] = pendingRangeAndThenableTuple;

    let values;
    try {
      values = await thenable;
    } finally {
      rangeMetadata.pendingRangeAndThenableTuples.splice(
        rangeMetadata.pendingRangeAndThenableTuples.indexOf(
          pendingRangeAndThenableTuple
        ),
        1
      );
    }

    rangeMetadata.loadedRanges = rangeUtils.mergeAll(
      ...rangeUtils.sort(...rangeMetadata.loadedRanges, [start, end])
    );

    // Check for duplicate values near the edges because of how ranges are split
    if (values.length > 0) {
      const firstValue = values[0];
      const index = findIndex(
        rangeMetadata.sortedValues,
        getPointForValue(firstValue),
        getPointForValue,
        comparePoints
      );
      if (index >= 0) {
        values.splice(0, 1);
      }
    }
    if (values.length > 0) {
      const lastValue = values[values.length - 1];
      const index = findIndex(
        rangeMetadata.sortedValues,
        getPointForValue(lastValue),
        getPointForValue,
        comparePoints
      );
      if (index >= 0) {
        values.pop();
      }
    }

    // Merge any remaining unique values
    if (values.length > 0) {
      const firstValue = values[0];
      const index = findNearestIndexAfter(
        rangeMetadata.sortedValues,
        getPointForValue(firstValue),
        getPointForValue,
        comparePoints
      );
      rangeMetadata.sortedValues.splice(index, 0, ...values);
    }
  }

  async function processPendingRecord(
    rangeMetadata: RangeMetadata<Point, Value>,
    record: Record<Value[]>,
    start: Point,
    end: Point,
    ...params: Params
  ) {
    assertPendingRecord(record);

    rangeMetadata.pendingRecords.add(record);

    const { abortController, deferred } = record.value;
    const { signal } = abortController;

    const foundRanges = findRanges<Point>(
      {
        loaded: rangeMetadata.loadedRanges,
        pending: rangeMetadata.pendingRangeAndThenableTuples.map(
          ([range]) => range
        ),
      },
      [start, end],
      rangeUtils
    );

    const missingThenables: Array<Value[] | Thenable<Value[]>> = [];
    foundRanges.missing.forEach(([start, end]) => {
      const thenable = load(start, end, ...params, abortController);

      missingThenables.push(thenable);

      const pendingRangeAndThenableTuple: PendingRangeAndThenableTuple<
        Point,
        Value
      > = [[start, end], thenable];

      rangeMetadata.pendingRangeAndThenableTuples.push(
        pendingRangeAndThenableTuple
      );

      processPendingRangeAndThenableTuple(
        rangeMetadata,
        pendingRangeAndThenableTuple,
        start,
        end,
        ...params
      );
    });

    // Gather all of the deferred requests the new range blocks on.
    // Can we make this more efficient than a nested loop?
    // It's tricky since requests initiated separately (e.g. [1,2] and [2,4])
    // may end up reported as single/merged blocker (e.g. [1,3])
    const pendingThenables: Array<Value[] | Thenable<Value[]>> = [];
    foundRanges.pending.forEach(([start, end]) => {
      rangeMetadata.pendingRangeAndThenableTuples.forEach(
        ([range, deferred]) => {
          if (rangeUtils.contains(range, [start, end])) {
            pendingThenables.push(deferred);
          }
        }
      );
    });

    try {
      await Promise.all([...missingThenables, ...pendingThenables]);

      if (!signal.aborted) {
        record.status = STATUS_RESOLVED;
        record.value = sliceValues<Point, Value>(
          rangeMetadata.sortedValues,
          start,
          end,
          getPointForValue,
          comparePoints
        );

        deferred.resolve(record.value);
      }
    } catch (error) {
      if (!signal.aborted) {
        record.status = STATUS_REJECTED;
        record.value = error;

        deferred.reject(error);
      }
    } finally {
      rangeMetadata.pendingRecords.delete(record);
    }
  }

  return {
    abort,
    evict,
    evictAll,
    fetchAsync,
    fetchSuspense,
  };
}

function defaultComparePoints(a: any, b: any): number {
  return a - b;
}
