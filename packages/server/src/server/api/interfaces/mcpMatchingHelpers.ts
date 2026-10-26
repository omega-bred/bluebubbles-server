import { invalidMcpRequest } from "@server/api/interfaces/mcpErrors";

type Match = { left: number; right: number; size: number };
type Range = { leftStart: number; leftEnd: number; rightStart: number; rightEnd: number };

export const MCP_FUZZY_MAX_CELL_WORK = 8_000_000;

export class McpMatchingBudget {
    private remaining: number;

    constructor(maximum = MCP_FUZZY_MAX_CELL_WORK) {
        this.remaining = maximum;
    }

    consume(leftLength: number, rightLength: number): void {
        const cost = Math.max(1, leftLength) * Math.max(1, rightLength);
        if (!Number.isSafeInteger(cost) || cost > this.remaining) {
            invalidMcpRequest("Fuzzy comparison exceeds the bounded computation budget");
        }
        this.remaining -= cost;
    }
}

function codePoints(value: string): string[] {
    return Array.from(value);
}

function longestMatch(left: string[], right: string[], range: Range): Match {
    let bestLeft = range.leftStart;
    let bestRight = range.rightStart;
    let bestSize = 0;
    let previous = new Map<number, number>();
    const rightIndices = new Map<string, number[]>();
    for (let index = range.rightStart; index < range.rightEnd; index += 1) {
        const values = rightIndices.get(right[index]) ?? [];
        values.push(index);
        rightIndices.set(right[index], values);
    }
    for (let leftIndex = range.leftStart; leftIndex < range.leftEnd; leftIndex += 1) {
        const current = new Map<number, number>();
        for (const rightIndex of rightIndices.get(left[leftIndex]) ?? []) {
            const size = (previous.get(rightIndex - 1) ?? 0) + 1;
            current.set(rightIndex, size);
            if (size > bestSize) {
                bestLeft = leftIndex - size + 1;
                bestRight = rightIndex - size + 1;
                bestSize = size;
            }
        }
        previous = current;
    }
    return { left: bestLeft, right: bestRight, size: bestSize };
}

function matchingBlocks(left: string[], right: string[], budget?: McpMatchingBudget): Match[] {
    const queue: Range[] = [{ leftStart: 0, leftEnd: left.length, rightStart: 0, rightEnd: right.length }];
    const blocks: Match[] = [];
    while (queue.length > 0) {
        const range = queue.shift()!;
        budget?.consume(range.leftEnd - range.leftStart, range.rightEnd - range.rightStart);
        const match = longestMatch(left, right, range);
        if (match.size === 0) continue;
        blocks.push(match);
        if (range.leftStart < match.left && range.rightStart < match.right) {
            queue.push({
                leftStart: range.leftStart,
                leftEnd: match.left,
                rightStart: range.rightStart,
                rightEnd: match.right
            });
        }
        if (match.left + match.size < range.leftEnd && match.right + match.size < range.rightEnd) {
            queue.push({
                leftStart: match.left + match.size,
                leftEnd: range.leftEnd,
                rightStart: match.right + match.size,
                rightEnd: range.rightEnd
            });
        }
    }
    return blocks.sort(
        (leftBlock, rightBlock) => leftBlock.left - rightBlock.left || leftBlock.right - rightBlock.right
    );
}

export function sequenceMatcherRatio(leftValue: string, rightValue: string, budget = new McpMatchingBudget()): number {
    const left = codePoints(leftValue);
    const right = codePoints(rightValue);
    const matches = matchingBlocks(left, right, budget).reduce((total, block) => total + block.size, 0);
    const total = left.length + right.length;
    return total === 0 ? 1 : (2 * matches) / total;
}

function fullProcess(value: string): string {
    return value
        .replace(/[\u0080-\u00ff]/gu, "")
        .replace(/[^\p{L}\p{N}]/gu, " ")
        .toLocaleLowerCase()
        .trim();
}

function lcsRatio(left: string, right: string, budget: McpMatchingBudget): number {
    const first = codePoints(left);
    const second = codePoints(right);
    if (first.length === 0 || second.length === 0) return first.length === second.length ? 1 : 0;
    budget.consume(first.length, second.length);
    const short = first.length <= second.length ? first : second;
    const long = first.length <= second.length ? second : first;
    let previous = new Uint32Array(short.length + 1);
    for (const longValue of long) {
        const current = new Uint32Array(short.length + 1);
        for (let index = 1; index <= short.length; index += 1) {
            current[index] =
                longValue === short[index - 1]
                    ? previous[index - 1] + 1
                    : Math.max(previous[index], current[index - 1]);
        }
        previous = current;
    }
    return (2 * previous[short.length]) / (first.length + second.length);
}

function partialRatio(leftValue: string, rightValue: string, budget: McpMatchingBudget): number {
    let shorter = codePoints(leftValue);
    let longer = codePoints(rightValue);
    if (shorter.length > longer.length) [shorter, longer] = [longer, shorter];
    if (shorter.length === 0) return longer.length === 0 ? 1 : 0;
    const candidates = new Set<string>();
    const blocks = matchingBlocks(shorter, longer, budget);
    for (const block of blocks) {
        const alignedStart = Math.max(0, block.right - block.left);
        candidates.add(longer.slice(alignedStart, alignedStart + shorter.length).join(""));
        candidates.add(longer.slice(block.right, block.right + block.size).join(""));
        if (shorter.length > 1) {
            const width = shorter.length - 1;
            const start = Math.max(0, Math.min(block.right, longer.length - width));
            candidates.add(longer.slice(start, start + width).join(""));
        }
    }
    candidates.add(longer.slice(0, shorter.length).join(""));
    candidates.add(longer.slice(Math.max(0, longer.length - shorter.length)).join(""));
    let best = 0;
    const shortValue = shorter.join("");
    for (const candidate of candidates) {
        if (candidate.length === 0) continue;
        best = Math.max(best, lcsRatio(shortValue, candidate, budget));
    }
    return best;
}

function sortedTokens(value: string): string {
    return value
        .split(/\s+/u)
        .filter(Boolean)
        .sort((left, right) => left.localeCompare(right))
        .join(" ");
}

function tokenSetValues(left: string, right: string): [string, string, string] {
    const leftTokens = new Set(left.split(/\s+/u).filter(Boolean));
    const rightTokens = new Set(right.split(/\s+/u).filter(Boolean));
    const intersection = Array.from(leftTokens)
        .filter(value => rightTokens.has(value))
        .sort();
    const leftOnly = Array.from(leftTokens)
        .filter(value => !rightTokens.has(value))
        .sort();
    const rightOnly = Array.from(rightTokens)
        .filter(value => !leftTokens.has(value))
        .sort();
    const common = intersection.join(" ");
    return [[...intersection, ...leftOnly].join(" "), [...intersection, ...rightOnly].join(" "), common];
}

function tokenSetRatio(left: string, right: string, partial: boolean, budget: McpMatchingBudget): number {
    const [leftCombined, rightCombined, common] = tokenSetValues(left, right);
    const scorer = partial ? partialRatio : lcsRatio;
    if (common.length === 0) return scorer(leftCombined, rightCombined, budget);
    return Math.max(
        scorer(common, leftCombined, budget),
        scorer(common, rightCombined, budget),
        scorer(leftCombined, rightCombined, budget)
    );
}

function roundHalfEven(value: number): number {
    const floor = Math.floor(value);
    const fraction = value - floor;
    if (Math.abs(fraction - 0.5) < 1e-10) return floor % 2 === 0 ? floor : floor + 1;
    return Math.round(value);
}

/** TheFuzz 0.22 compatible WRatio, with an explicit per-request CPU budget. */
export function weightedRatio(leftValue: string, rightValue: string, budget = new McpMatchingBudget()): number {
    const left = fullProcess(leftValue);
    const right = fullProcess(rightValue);
    if (left.length === 0 || right.length === 0) return 0;
    const base = lcsRatio(left, right, budget);
    const leftLength = codePoints(left).length;
    const rightLength = codePoints(right).length;
    const lengthRatio = Math.max(leftLength, rightLength) / Math.min(leftLength, rightLength);
    let best = base;
    if (lengthRatio >= 1.5) {
        const partialScale = lengthRatio > 8 ? 0.6 : 0.9;
        best = Math.max(
            best,
            partialRatio(left, right, budget) * partialScale,
            partialRatio(sortedTokens(left), sortedTokens(right), budget) * 0.95 * partialScale,
            tokenSetRatio(left, right, true, budget) * 0.95 * partialScale
        );
    } else {
        best = Math.max(
            best,
            lcsRatio(sortedTokens(left), sortedTokens(right), budget) * 0.95,
            tokenSetRatio(left, right, false, budget) * 0.95
        );
    }
    return roundHalfEven(best * 100) / 100;
}

export function messageSimilarity(query: string, body: string | null, budget = new McpMatchingBudget()): number {
    const left = query.trim().toLocaleLowerCase();
    const right = (body ?? "").trim().toLocaleLowerCase();
    if (left.length === 0) return 1;
    if (right.includes(left)) return 1;
    return weightedRatio(left, right, budget);
}

export function contactSimilarity(
    queryValue: string,
    candidateValue: string,
    budget = new McpMatchingBudget(),
    threshold = 0.6
): number {
    const clean = (value: string) =>
        value
            .replace(/[^\p{L}\p{N}_'\-\s]/gu, "")
            .replace(/\s+/gu, " ")
            .trim()
            .toLocaleLowerCase();
    const query = clean(queryValue);
    const candidate = clean(candidateValue);
    if (query.length === 0) return 0;
    if (query === candidate) return 1;
    let best = 0;
    for (const token of candidate.split(" ")) {
        if (query === token) best = Math.max(best, 0.95);
        else if (token.startsWith(query)) best = Math.max(best, (0.85 * query.length) / token.length);
        else if (query.startsWith(token)) best = Math.max(best, (0.8 * token.length) / query.length);
        else best = Math.max(best, sequenceMatcherRatio(query, token, budget));
    }
    if (query.includes(" ") || best < threshold) {
        best = Math.max(best, sequenceMatcherRatio(query, candidate, budget));
    }
    return best;
}
