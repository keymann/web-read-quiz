import { describe, expect, it } from "vitest";
import { mostlyUngrounded, shortfallNotice } from "../src/services/generation";
import {
	MIN_EVIDENCE_GROUNDING,
	MIN_QUESTION_GROUNDING,
	checkGrounding,
	groundedRatio,
} from "../src/services/grounding";

/**
 * 근거 검사 — 문항이 **제공된 책 정보 안에서** 나왔는지(§9·§10).
 *
 * 검수 과정에서 없는 장면을 다룬 문항이 나온 것이 계기다. 프롬프트로 "지어내지 마세요" 라고
 * 부탁하는 것만으로는 부족했다 — 지어내는 모델은 근거도 함께 지어낸다. AI 검증도 도움이
 * 안 된다: 같은 모델이 같은 책을 검수하므로 잘못 기억하면 출제도 검수도 같이 틀린다.
 *
 * 아래 표본은 **실제 Gemini 출력**이다. 임계값은 이 두 무리를 재서 정했다.
 */

/** 제대로 조사한 Book Brief. 실제 조사 결과에서 가져왔다. */
const BRIEF = "[책] 마당을 나온 암탉\n지은이: 황선미 / 출판사: 사계절 / 출간: 2000-05-29\n권장 독자: 초등학교 고학년\n\n[소개]\n양계장에 갇혀 알만 낳던 암탉 잎싹이 자유를 찾아 마당을 벗어나, 야생에서 청둥오리 알을 품어 아기 오리 초록이를 키워내는 감동적인 이야기입니다. 잎싹의 헌신적인 모성애와 삶의 주체성, 그리고 자연의 생명 순환 법칙을 깊이 있게 다루고 있습니다.\n\n[줄거리]\n좁은 닭장 속에서 알만 낳던 암탉 잎싹은 자신의 알을 품어 보고 마당을 거니는 꿈을 꿉니다. 폐계가 되어 구덩이에 버려진 잎싹은 청둥오리 나그네의 도움으로 족제비의 습격에서 벗어나 들판에서 자유를 얻게 됩니다. 이후 잎싹은 족제비에게 아내를 잃은 나그네가 남긴 알을 발견하고 정성껏 품어 부화시킵니다. 나그네는 밤마다 잎싹과 알을 지키다가 족제비에게 목숨을 잃고, 알에서 깨어난 청둥오리 초록이는 잎싹을 엄마로 알고 자랍니다. 잎싹은 초록이가 자신과 생긴 모습이 다르고 수영과 비행을 좋아하는 청둥오리임을 받아들이며 애정으로 기릅니다. 자란 초록이는 자신의 정체성을 찾아 겨울에 찾아온 청둥오리 떼와 함께 먼 길을 떠납니다. 자식을 떠나보내고 기력이 다한 잎싹은 굶주린 새끼들을 먹여 살려야 하는 족제비의 처지를 이해하며, 족제비의 먹이로 자신의 몸을 기꺼이 내어줌으로써 생명의 순환 속에 온전한 자유를 맞이합니다.\n\n[등장인물]\n- 잎싹: 자유와 모성애를 지닌 암탉. 양계장을 탈출해 청둥오리 알을 품어 초록이를 정성껏 키워내는 주인공입니다.\n- 초록이: 잎싹이 품어 키운 청둥오리. 자신의 정체성에 대해 고민하지만 엄마인 잎싹의 사랑을 깨닫고 야생 청둥오리 무리의 리더로 성장합니다.\n- 나그네: 야생 청둥오리이자 초록이의 친아버지. 잎싹과 자신의 알을 족제비로부터 지키기 위해 싸우다 목숨을 잃습니다.\n- 족제비: 야생의 포식자이자 악역. 먹이사슬 속에서 자신의 굶주린 새끼들을 위해 끊임없이 사냥해야 하는 야생의 냉혹한 현실을 보여줍니다.\n\n[주요 사건 — 일어난 순서]\n1. 양계장에서 알만 낳던 암탉 잎싹은 알을 품고 싶다는 꿈을 안고 폐계로 위장해 양계장 밖 구덩이로 나온다.\n2. 족제비에게 잡아먹힐 위기에서 청둥오리 나그네의 도움을 받아 목숨을 구하고 들판에 정착한다.\n3. 잎싹은 주인 없이 남겨진 알을 발견해 정성껏 품고, 나그네는 밤마다 족제비로부터 잎싹과 알을 지키다 희생된다.\n4. 알에서 태어난 청둥오리 아기 '초록이'를 잎싹이 어미로서 사랑과 정성으로 키운다.\n5. 초록이는 점차 자라나 날개짓을 배우고, 자신이 닭이 아닌 오리라는 정체성을 깨달아간다.\n6. 가을이 되어 찾아온 청둥오리 무리와 함께 초록이가 하늘로 날아오르자, 잎싹은 기쁜 마음으로 자식을 떠나보낸다.\n7. 늙고 홀로 남은 잎싹은 새끼들을 먹이기 위해 사냥하는 족제비를 이해하고, 스스로 먹이가 되어주며 생을 마감한다.";

/** 그 Brief 로 만들어진 문항. 근거를 원문에서 인용했다. */
const GROUNDED = [
	{
		"questionText": "잎싹이 구덩이에 버려진 후 족제비의 습격에서 벗어날 수 있도록 도와주고 들판에서 자유를 얻게 해 준 동물은 누구인가요?",
		"choices": [
			"마당의 수탉",
			"청둥오리 나그네",
			"아기 오리 초록이",
			"양계장 주인"
		],
		"correctChoice": 2,
		"evidence": "폐계가 되어 구덩이에 버려진 잎싹은 청둥오리 나그네의 도움으로 족제비의 습격에서 벗어나 들판에서 자유를 얻게 됩니다."
	},
	{
		"questionText": "등장인물 중 먹이사슬 속에서 자신의 굶주린 새끼들을 위해 끊임없이 사냥해야 하는 야생의 포식자는 누구인가요?",
		"choices": [
			"잎싹",
			"나그네",
			"초록이",
			"족제비"
		],
		"correctChoice": 4,
		"evidence": "족제비: 야생의 포식자이자 악역. 먹이사슬 속에서 자신의 굶주린 새끼들을 위해 끊임없이 사냥해야 하는 야생의 냉혹한 현실을 보여줍니다."
	},
	{
		"questionText": "좁은 닭장 속에서 알만 낳던 암탉 잎싹이 가슴속에 품고 있던 꿈은 무엇이었나요?",
		"choices": [
			"자신의 알을 품어 보고 마당을 거니는 꿈",
			"양계장을 차지하여 주인이 되는 꿈",
			"하늘을 높이 날아다니는 오리가 되는 꿈",
			"족제비를 물리치고 마당을 지키는 꿈"
		],
		"correctChoice": 1,
		"evidence": "좁은 닭장 속에서 알만 낳던 암탉 잎싹은 자신의 알을 품어 보고 마당을 거니는 꿈을 꿉니다."
	},
	{
		"questionText": "청둥오리 나그네가 목숨을 잃게 된 원인은 무엇인가요?",
		"choices": [
			"겨울에 멀리 날아가다가 추위를 이기지 못해서",
			"양계장 구덩이에 빠져 빠져나오지 못해서",
			"밤마다 잎싹과 알을 족제비로부터 지키다가",
			"초록이와 다투고 들판을 떠나버려서"
		],
		"correctChoice": 3,
		"evidence": "나그네는 밤마다 잎싹과 알을 지키다가 족제비에게 목숨을 잃고, 알에서 깨어난 청둥오리 초록이는 잎싹을 엄마로 알고 자랍니다."
	}
];

/** 한 줄짜리 Brief 로 만들어져 모델의 기억으로 채워진 문항. */
const INVENTED = [
	{
		"questionText": "잎싹이가 양계장에서 병들어 구덩이에 버려졌을 때, 족제비의 공격으로부터 잎싹이를 구해준 동물은 누구인가요?",
		"choices": [
			"마당의 늙은 닭",
			"마당을 지키는 문지기 개",
			"청머리오리 나그네",
			"과수원 주인의 고양이"
		],
		"correctChoice": 3,
		"evidence": "족제비가 잎싹이를 덮치려는 순간 청머리오리 나그네가 날아와 족제비와 싸워 잎싹이를 목숨 건져 줍니다."
	},
	{
		"questionText": "잎싹이가 찔레덩굴 속에서 나그네 오리 부부가 남긴 알을 발견했을 때, 그 알을 품기로 결심한 가장 결정적인 마음은 무엇이었나요?",
		"choices": [
			"알이 따뜻했고 자신이 한 번도 가져보지 못한 아기에 대한 사랑 때문",
			"알을 팔아서 족제비에게 줄 먹이를 구하기 위해",
			"마당 주인의 눈을 피해 알을 숨겨두고 싶어서",
			"다른 오리들에게 자신의 능력을 자랑하고 싶어서"
		],
		"correctChoice": 1,
		"evidence": "잎싹이는 찔레덩굴 속 알이 아직 따뜻함을 느끼고, 그동안 알을 품어보지 못했던 간절한 모성애로 알을 감싸 안습니다."
	}
];

describe("근거 점수", () => {
	it("Brief 의 문장을 그대로 인용하면 1 이다", () => {
		expect(groundedRatio("좁은 닭장 속에서 알만 낳던 암탉 잎싹", BRIEF)).toBe(1);
	});

	it("Brief 에 없는 말이면 0 에 가깝다", () => {
		expect(groundedRatio("우주선 선장이 외계인과 싸웠다", BRIEF)).toBeLessThan(0.3);
	});

	// 한국어는 조사가 붙어 형태가 달라진다. 토큰을 그대로 비교하면 멀쩡한 근거가 다 떨어진다.
	it("조사가 붙어도 같은 말로 본다", () => {
		expect(groundedRatio("잎싹이가 잎싹은 잎싹을", BRIEF)).toBe(1);
	});
});

describe("실측 표본", () => {
	it("제대로 조사한 정보로 만든 문항은 통과한다", () => {
		for (const question of GROUNDED) {
			const result = checkGrounding(question, BRIEF);
			expect(result.ok, `${question.questionText} — ${result.reason}`).toBe(true);
			expect(result.evidenceRatio).toBeGreaterThanOrEqual(MIN_EVIDENCE_GROUNDING);
		}
	});

	it("기억으로 지어낸 문항은 걸러진다", () => {
		for (const question of INVENTED) {
			const result = checkGrounding(question, BRIEF);
			expect(result.ok, question.questionText).toBe(false);
			expect(result.reason).toContain("제공된 책 정보");
		}
	});

	/**
	 * 두 무리 사이가 넓어야 임계값을 조금 옮겨도 판정이 뒤집히지 않는다.
	 *
	 * 지어낸 쪽이 0 이 아닌 것에 주의. 이 표본은 **실제 있는 사건을 다루되 세부를 지어낸**
	 * 문항이라 낱말이 어느 정도 겹친다(0.5 언저리). 통째로 없는 이야기보다 잡기 어려운
	 * 쪽인데, 그래도 인용한 문항(1.0)과는 확실히 갈린다.
	 */
	it("두 무리 사이에 여유가 있다", () => {
		const good = Math.min(...GROUNDED.map((q) => checkGrounding(q, BRIEF).evidenceRatio));
		const bad = Math.max(...INVENTED.map((q) => checkGrounding(q, BRIEF).evidenceRatio));

		expect(good).toBeGreaterThanOrEqual(0.9);
		expect(bad).toBeLessThan(MIN_EVIDENCE_GROUNDING);
		// 임계값이 두 무리 사이에 있다
		expect(MIN_EVIDENCE_GROUNDING).toBeGreaterThan(bad);
		expect(MIN_EVIDENCE_GROUNDING).toBeLessThan(good);
	});
});

describe("출제 언어가 다를 때", () => {
	/**
	 * 문제 언어를 영어로 두면 문항은 영어인데 Brief 는 한국어다(§17). 글자를 맞대면 아무리
	 * 충실한 문항도 0 점이 나온다 — 이걸 못 보면 영어 출제가 통째로 막힌다.
	 *
	 * 근거는 원문 그대로 인용하도록 시켰으므로 그것만으로 판정한다.
	 */
	it("영어 문항이라도 근거가 원문이면 통과한다", () => {
		const question = {
			questionText: "What did Ipssak want more than anything?",
			choices: ["To hatch her own egg", "To leave the farm", "To fly away", "To sleep"],
			correctChoice: 1,
			evidence: "좁은 닭장 속에서 알만 낳던 암탉 잎싹은 자신의 알을 품어 보고",
		};

		expect(checkGrounding(question, BRIEF).ok).toBe(true);
	});

	it("영어 문항이어도 근거가 지어낸 것이면 걸러진다", () => {
		const question = {
			questionText: "Which spaceship did Ipssak pilot?",
			choices: ["The Falcon", "The Eagle", "The Hawk", "The Dove"],
			correctChoice: 1,
			evidence: "The hen boarded a spaceship and flew to Mars with her crew.",
		};

		expect(checkGrounding(question, BRIEF).ok).toBe(false);
	});
});

describe("대조할 것이 없으면 막지 않는다", () => {
	// Brief 가 비었는데 전부 떨어뜨리면 문제를 하나도 만들 수 없다.
	it("Brief 가 비어 있으면 검사하지 않는다", () => {
		const question = {
			questionText: "아무 말",
			choices: ["가", "나", "다", "라"],
			correctChoice: 1,
			evidence: "아무 근거",
		};

		expect(checkGrounding(question, "").ok).toBe(true);
	});
});

describe("부모에게 보여줄 안내", () => {
	/**
	 * "검수를 통과한 문제가 없습니다" 만 보여주면 부모는 다시 생성을 누른다. 같은 정보로
	 * 다시 돌리면 같은 이유로 걸리므로 시간과 AI 비용만 든다. 원인을 짚어 줘야 한다.
	 */
	it("근거 부족이 주된 사유면 책 정보를 보강하라고 말한다", () => {
		const rejected = [
			{ reason: "근거가 제공된 책 정보에 없는 내용입니다." },
			{ reason: "문제와 정답이 제공된 책 정보에 없는 인물·장면을 다룹니다." },
			{ reason: "검수 기준을 통과하지 못했습니다." },
		];

		expect(mostlyUngrounded(rejected)).toBe(true);
		expect(shortfallNotice(20, 0, rejected)).toContain("정보 다시 찾기");
	});

	it("다른 사유가 많으면 다시 생성하라고 말한다", () => {
		const rejected = [
			{ reason: "검수 기준을 통과하지 못했습니다." },
			{ reason: "이미 만든 다른 문제와 내용이 겹칩니다." },
			{ reason: "근거가 제공된 책 정보에 없는 내용입니다." },
		];

		expect(mostlyUngrounded(rejected)).toBe(false);
		expect(shortfallNotice(20, 12, rejected)).toContain("다시 생성");
	});
});

describe("오답 선택지", () => {
	/**
	 * 오답은 그럴듯하게 지어내는 것이 제 역할이다. Brief 에 없는 이름이 나오는 게 정상이라
	 * 검사 대상에서 뺀다. 여기까지 막으면 사지선다를 만들 수 없다.
	 */
	it("오답이 Brief 에 없어도 통과한다", () => {
		const question = {
			questionText: "잎싹이 품은 알에서 태어난 것은?",
			choices: ["청둥오리 초록이", "용과 봉황", "우주 로봇", "말하는 고양이"],
			correctChoice: 1,
			evidence: "알에서 깨어난 청둥오리 초록이는 잎싹을 엄마로 알고 자랍니다",
		};

		const result = checkGrounding(question, BRIEF);
		expect(result.ok, result.reason ?? "").toBe(true);
		expect(MIN_QUESTION_GROUNDING).toBeLessThan(1);
	});
});
