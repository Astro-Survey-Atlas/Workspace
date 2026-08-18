export interface QueryRect {
  raMin: number;
  raMax: number;
  decMin: number;
  decMax: number;
}

const RECT_EPSILON = 1e-6;

function validRect(rect: QueryRect): boolean {
  return rect.raMax - rect.raMin > RECT_EPSILON && rect.decMax - rect.decMin > RECT_EPSILON;
}

function sameValue(left: number, right: number): boolean {
  return Math.abs(left - right) <= RECT_EPSILON;
}

function contains(outer: QueryRect, inner: QueryRect): boolean {
  return outer.raMin <= inner.raMin + RECT_EPSILON
    && outer.raMax >= inner.raMax - RECT_EPSILON
    && outer.decMin <= inner.decMin + RECT_EPSILON
    && outer.decMax >= inner.decMax - RECT_EPSILON;
}

export function subtractRect(target: QueryRect, blocker: QueryRect): QueryRect[] {
  const raMin = Math.max(target.raMin, blocker.raMin);
  const raMax = Math.min(target.raMax, blocker.raMax);
  const decMin = Math.max(target.decMin, blocker.decMin);
  const decMax = Math.min(target.decMax, blocker.decMax);
  if (raMax - raMin <= RECT_EPSILON || decMax - decMin <= RECT_EPSILON) return [{ ...target }];

  return [
    { raMin: target.raMin, raMax: target.raMax, decMin: target.decMin, decMax: decMin },
    { raMin: target.raMin, raMax: target.raMax, decMin: decMax, decMax: target.decMax },
    { raMin: target.raMin, raMax: raMin, decMin, decMax },
    { raMin: raMax, raMax: target.raMax, decMin, decMax },
  ].filter(validRect);
}

export function subtractRects(targets: readonly QueryRect[], blockers: readonly QueryRect[]): QueryRect[] {
  return blockers.reduce<QueryRect[]>(
    (remaining, blocker) => remaining.flatMap((target) => subtractRect(target, blocker)),
    targets.filter(validRect).map((target) => ({ ...target })),
  );
}

export function compactRects(rects: readonly QueryRect[]): QueryRect[] {
  const compacted: QueryRect[] = [];
  rects.filter(validRect).forEach((candidate) => {
    if (compacted.some((rect) => contains(rect, candidate))) return;
    for (let index = compacted.length - 1; index >= 0; index -= 1) {
      if (contains(candidate, compacted[index]!)) compacted.splice(index, 1);
    }
    compacted.push({ ...candidate });
  });

  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let leftIndex = 0; leftIndex < compacted.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < compacted.length; rightIndex += 1) {
        const left = compacted[leftIndex]!;
        const right = compacted[rightIndex]!;
        let replacement: QueryRect | null = null;
        if (sameValue(left.decMin, right.decMin) && sameValue(left.decMax, right.decMax)
          && (left.raMax + RECT_EPSILON >= right.raMin && right.raMax + RECT_EPSILON >= left.raMin)) {
          replacement = { raMin: Math.min(left.raMin, right.raMin), raMax: Math.max(left.raMax, right.raMax), decMin: left.decMin, decMax: left.decMax };
        } else if (sameValue(left.raMin, right.raMin) && sameValue(left.raMax, right.raMax)
          && (left.decMax + RECT_EPSILON >= right.decMin && right.decMax + RECT_EPSILON >= left.decMin)) {
          replacement = { raMin: left.raMin, raMax: left.raMax, decMin: Math.min(left.decMin, right.decMin), decMax: Math.max(left.decMax, right.decMax) };
        }
        if (!replacement) continue;
        compacted.splice(rightIndex, 1);
        compacted.splice(leftIndex, 1, replacement);
        merged = true;
        break outer;
      }
    }
  }
  return compacted;
}
