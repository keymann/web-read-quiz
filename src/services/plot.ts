/**
 * 책 내용 쌓기 — "정보 다시 찾기" 는 갈아 끼우는 일이 아니라 **더하는 일**이다.
 *
 * 줄거리·등장인물·주요 사건 셋을 모두 여기서 합친다. 세 값은 한 조사가 함께 돌려주고 함께
 * Brief 에 실리므로, 쌓는 규칙도 한 곳에 둔다.
 *
 * 예전에는 이 일을 프롬프트에게 부탁했다. 조사할 때 `[지금까지 정리한 줄거리]` 를 되돌려 주고
 * "지우지 말고 보강하세요" 라고 시켰다(`search/web.ts`). 모델은 그 말을 자주 흘렸다 — 다시
 * 찾을 때마다 줄거리가 통째로 새 것으로 갈렸고, 이번 자료가 지난 자료보다 얇으면 줄거리가
 * 오히려 짧아졌다. 부모가 그 버튼을 누른 뜻과 반대다.
 *
 * 그래서 서버가 **문장 단위로 합친다.** 지난 줄거리를 그대로 두고, 이번 조사가 새로 말한
 * 문장만 뒤에 붙인다. 프롬프트의 부탁은 그대로 둔다 — 모델이 말을 들으면 이 합치기가 할 일이
 * 거의 없고, 안 들어도 지난 줄거리는 남는다.
 */

/**
 * 두 문장이 같은 말인지 **두 글자 조각**으로 견준다.
 *
 * 낱말로 견주면 안 된다. 줄거리는 같은 인물·장소 이름을 계속 되풀이하므로, 새 사건을 말하는
 * 문장도 낱말은 이미 나온 것과 거의 겹친다("잎싹", "마당", "족제비"). 그것을 "이미 담긴 문장"
 * 으로 보면 정작 새로 찾은 사건이 버려진다 — 쌓으려고 만든 장치가 반대로 깎아낸다.
 *
 * 두 글자 조각은 어순과 조사까지 함께 본다. 같은 문장을 제 말로 다시 쓴 것은 조각이 대부분
 * 겹치고, 같은 인물의 다른 사건은 이름만 겹친다.
 */
const flatten = (text: string): string =>
	text.toLowerCase().replace(/[\s.,!?"'“”‘’()［］[\]<>·…~\-—:;/]/g, "");

const shingles = (text: string): Set<string> => {
	const flat = flatten(text);
	const out = new Set<string>();
	for (let i = 0; i + 2 <= flat.length; i++) out.add(flat.slice(i, i + 2));
	// 두 글자보다 짧은 토막은 자기 자신이 유일한 조각이다.
	if (out.size === 0 && flat !== "") out.add(flat);
	return out;
};

/** `text` 의 조각이 `other` 에 얼마나 들어 있는지. 0~1. */
const coverageOf = (text: Set<string>, other: Set<string>): number => {
	if (text.size === 0) return 1;
	let hit = 0;
	for (const gram of text) if (other.has(gram)) hit++;
	return hit / text.size;
};

/**
 * 이미 담긴 문장으로 보는 겹침 비율.
 *
 * 방향이 있다 — **새 문장의 조각이 지난 문장 안에 얼마나 들어 있는지**를 본다. 새 문장이 지난
 * 문장을 다시 쓴 것이면 1 에 가깝고, 지난 문장에 살을 붙여 더 자세히 쓴 것이면 낮게 나와
 * 자세한 쪽이 남는다.
 *
 * 0.7 은 되풀이(0.85 이상)와 같은 인물의 새 사건(0.5 아래) 사이다. 낮추면 새로 찾은 사건이
 * 버려지고, 높이면 같은 말이 라운드마다 쌓여 Brief 가 부푼다. 둘 중 잃는 쪽이 더 나쁘므로
 * 애매하면 남기는 편으로 둔다.
 */
const COVERED = 0.7;

/**
 * 쌓아 둘 줄거리의 상한(자).
 *
 * Brief 는 **문제 생성 라운드마다** 프롬프트에 그대로 실린다. 여기가 한없이 부풀면 매 라운드
 * 비용이 늘고 모델이 중간을 흘린다. 부모가 직접 적는 줄거리 상한(`MAX_MANUAL_PLOT` = 4,000)
 * 보다 넉넉히 두어, 몇 번을 다시 찾아도 쌓을 자리가 남게 한다.
 */
export const MAX_PLOT = 6_000;

/**
 * 문장으로 자른다. 줄바꿈도 경계로 본다 — 모델이 항목을 줄로 나눠 보내는 일이 흔하다.
 */
export const splitSentences = (text: string): string[] =>
	text
		.split(/(?<=[.!?…])\s+|\n+/)
		.map((line) => line.trim())
		.filter((line) => line !== "");

/**
 * Brief 는 `[이름]` 만 있는 줄을 **절 경계로 읽는다**(`services/grounding.ts`). 그런 줄이
 * 줄거리 안에 섞이면 절이 쪼개져, 뒤따르는 문장이 근거 대조 범위에서 빠진다.
 */
const HEADER_LIKE = /^\[[^\]]+\]$/;

/**
 * 지난 줄거리에 이번 줄거리를 더한다. **지난 것을 지우지 않는다.**
 *
 * 지난 문장은 순서까지 그대로 남고, 이번 조사가 새로 말한 문장이 뒤에 붙는다. 이미 담긴
 * 문장은 버린다 — 모델은 지난 줄거리를 제 말로 다시 쓴 뒤 새 사건을 붙이는 일이 많아서,
 * 그것을 그대로 받으면 같은 이야기가 두 번 적힌다.
 *
 * 틀린 대목을 덜어내는 일은 여기서 하지 않는다. 그것은 자료를 보고 판단해야 하는 일이라
 * 조사 프롬프트에 맡긴다 — 다만 그 판단이 지난 줄거리를 통째로 버리는 것까지 허락하지는
 * 않는다는 것이 이 함수의 뜻이다.
 */
export function mergePlot(prior: string, next: string): string {
	const base = prior.trim();
	const incoming = next.trim();

	/*
	 * 쌓을 것이 없으면 **손대지 않고 그대로 쓴다.**
	 *
	 * 처음 찾은 책은 이 함수가 있기 전과 똑같아야 한다. 문장으로 잘라 다시 이어 붙이면 쌓을
	 * 것도 없는데 글이 바뀌고, 되풀이 판정이 멀쩡한 문장까지 걸러낼 여지가 생긴다.
	 */
	if (base === "") return incoming;
	if (incoming === "") return base;

	const priorGrams = splitSentences(base).map(shingles);
	const added: string[] = [];
	// 쌓아 둔 것은 한 덩어리로 그대로 남기고, 새 문장만 뒤에 붙인다.
	let length = base.length;

	for (const sentence of splitSentences(incoming)) {
		if (HEADER_LIKE.test(sentence)) continue;

		const gram = shingles(sentence);
		if (priorGrams.some((prev) => coverageOf(gram, prev) >= COVERED)) continue;
		// 상한에 닿으면 더 붙이지 않는다. 쌓아 둔 것을 잘라내지는 않는다 — 이미 이 줄거리로
		// 만든 문항들이 그 글을 근거로 삼고 있다.
		if (length >= MAX_PLOT) break;

		priorGrams.push(gram);
		added.push(sentence);
		length += sentence.length + 1;
	}

	return added.length === 0 ? base : [base, ...added].join("\n");
}

/** 조사가 돌려주는 등장인물 한 사람. `search/web.ts` 의 `BookResearch` 와 같은 모양이다. */
export interface Character {
	name: string;
	role: string;
}

/**
 * 쌓아 둘 등장인물·사건의 수.
 *
 * 줄거리와 같은 이유로 상한을 둔다 — 셋 다 Brief 에 실려 문제 생성 라운드마다 프롬프트로
 * 나간다. 아동서 한 권은 인물 열 명, 사건 열다섯 개를 넘기지 않아, 이 값은 몇 번을 다시
 * 찾아도 닿지 않는 여유값이다.
 */
export const MAX_CHARACTERS = 30;
export const MAX_EVENTS = 60;

/**
 * 등장인물을 더한다. **이름으로 같은 사람인지 가린다.**
 *
 * 이름은 조사마다 거의 그대로 오지만 역할 설명은 자세함이 갈린다("암탉" / "양계장을 나와
 * 알을 품는 암탉"). 그래서 같은 사람이면 **더 자세히 적힌 쪽**을 남긴다 — 문제를 만들 때
 * 쓸모가 있는 쪽이다.
 */
export function mergeCharacters(prior: Character[], next: Character[]): Character[] {
	const pooled = prior.map((person) => ({ name: person.name.trim(), role: person.role.trim() }));
	const at = new Map(pooled.map((person, index) => [flatten(person.name), index]));

	for (const raw of next) {
		const name = raw.name.trim();
		const role = raw.role.trim();
		const key = flatten(name);
		if (key === "") continue;

		const found = at.get(key);
		if (found === undefined) {
			if (pooled.length >= MAX_CHARACTERS) continue;
			at.set(key, pooled.length);
			pooled.push({ name, role });
			continue;
		}

		if (role.length > pooled[found]!.role.length) pooled[found]!.role = role;
	}

	return pooled;
}

/**
 * 주요 사건을 더한다. **순서는 이번 조사가 정한다.**
 *
 * 줄거리와 반대로 이번 결과를 앞에 세운다. 이 목록의 이름은 `[주요 사건 — 일어난 순서]` 이고
 * 그 순서로 순서 문항이 나온다. 지난 목록을 앞에 두고 새 사건을 뒤에 붙이면, 이야기 앞머리에서
 * 새로 찾은 사건이 맨 끝에 놓여 **순서가 거짓이 된다.**
 *
 * 그래서 이번 조사가 늘어놓은 순서를 그대로 받고, 그 목록에서 빠진 지난 사건만 뒤에 붙여
 * 잃지 않게 한다. 이번 조사에는 지난 사건 목록도 함께 넘기므로(`search/web.ts`), 모델이 말을
 * 들으면 뒤에 붙을 것이 없다.
 */
export function mergeEvents(prior: string[], next: string[]): string[] {
	const pooled: string[] = [];
	const grams: Set<string>[] = [];

	const add = (raw: string): void => {
		const event = raw.trim();
		if (event === "" || HEADER_LIKE.test(event)) return;

		const gram = shingles(event);
		if (grams.some((prev) => coverageOf(gram, prev) >= COVERED)) return;
		if (pooled.length >= MAX_EVENTS) return;

		pooled.push(event);
		grams.push(gram);
	};

	for (const event of next) add(event);
	for (const event of prior) add(event);

	return pooled;
}
