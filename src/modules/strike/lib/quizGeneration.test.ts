import { describe, it, expect } from "vitest";
import {
  parseSingleQuestion,
  QualityCheckError,
} from "./quizGeneration";
import type { InternetResearch } from "./internetResearch";

// Minimal but valid research so grounding checks pass. The correct answers in
// the "accepts a new question" cases below are grounded verbatim here.
const research: InternetResearch = {
  subject: "Photosynthesis",
  sources: [],
  passages: [
    {
      title: "Photosynthesis",
      url: "https://example.com/phot",
      text: "Photosynthesis occurs inside the chloroplasts of plant cells. Chlorophyll absorbs sunlight and uses that light energy to convert carbon dioxide and water into glucose and oxygen.",
    },
  ],
  relatedTerms: [],
  context:
    "Photosynthesis occurs inside the chloroplasts of plant cells. Chlorophyll absorbs sunlight.",
};

function json(obj: object) {
  return JSON.stringify(obj);
}

function baseQuestion(prompt: string, correct: string) {
  return json({
    prompt,
    options: [correct, "A different plausible idea", "Another reasonable guess", "A fourth competing view"],
    answer: 0,
    hint: "A conceptual nudge here.",
    explanation: "The correct option is right because it matches the passage.",
  });
}

describe("parseSingleQuestion: no-repeat dedup enforcement", () => {
  it("rejects a question whose prompt equals a previously asked one", () => {
    const q = baseQuestion("How do plants make glucose?", "By photosynthesis in their chloroplasts.");
    // A prompt that matches a previously asked question must be rejected.
    expect(() => parseSingleQuestion(q, "Photosynthesis", 2, research, ["How do plants make glucose?"])).toThrow(
      QualityCheckError,
    );
  });

  it("rejects a prompt that only matches case/space variants (normalized dedup)", () => {
    const q = baseQuestion("How DO plants MAKE glucose?", "By photosynthesis in their chloroplasts.");
    // Different casing / spacing, but normalizes to the same topic text.
    expect(() =>
      parseSingleQuestion(q, "Photosynthesis", 2, research, ["How do plants make glucose?"]),
    ).toThrow(QualityCheckError);
  });

  it("accepts a genuinely new prompt when the exclude list is empty", () => {
    const q = baseQuestion("What role does chlorophyll play in photosynthesis?", "It captures light energy for the reaction.");
    const parsed = parseSingleQuestion(q, "Photosynthesis", 2, research, []);
    expect(parsed.prompt).toBe("What role does chlorophyll play in photosynthesis?");
    expect(parsed.answer).toBe(0);
    expect(parsed.options).toHaveLength(4);
  });

  it("accepts a genuinely new prompt even alongside other excludes", () => {
    const q = baseQuestion("Where in the plant cell does photosynthesis occur?", "Inside the chloroplast's membranes.");
    const parsed = parseSingleQuestion(
      q,
      "Photosynthesis",
      2,
      research,
      ["How do plants make glucose?", "When did photosynthesis first appear?"],
    );
    expect(parsed.prompt).toBe("Where in the plant cell does photosynthesis occur?");
  });
});

describe("parseSingleQuestion: rejects unverifiable comparison / uniqueness questions", () => {
  // A "comics" style source that contains the generic words ("character",
  // "comics", "superhero") that used to trick the grounding check into
  // accepting the false Atom Eve claim.
  const atomResearch: InternetResearch = {
    subject: "Atom",
    sources: [],
    passages: [
      {
        title: "Atom (comics)",
        url: "https://example.com/atom",
        text: "The Atom is a character appearing in DC Comics. Ray Palmer is a superhero character who first appeared in Showcase. The character can alter his size and mass.",
      },
    ],
    relatedTerms: [],
    context: "The Atom is a character appearing in DC Comics.",
  };

  function payload(prompt: string, options: string[]) {
    return json({
      prompt,
      options,
      answer: 0,
      hint: "A conceptual nudge here.",
      explanation: "The passage supports this choice.",
    });
  }

  it("rejects a cross-entity 'distinguishes X from Y' prompt", () => {
    const q = payload(
      "Based on the text, what characteristic distinguishes Atom Eve from the other Atom characters?",
      [
        "She is a character in DC Comics.",
        "She can alter her size and mass.",
        "She first appeared in Showcase.",
        "She is a superhero.",
      ],
    );
    expect(() => parseSingleQuestion(q, "Atom", 2, atomResearch, [])).toThrow(QualityCheckError);
  });

  it("rejects a question whose choices are 'only/sole' uniqueness claims", () => {
    const q = payload("Which statement about Atom Eve is correct according to the text?", [
      "She is the only Atom character to appear in DC Comics.",
      "She is the only Atom character with a name derived from atom.",
      "She is the only Atom character published by All-American.",
      "She is the only Atom character who is not a superhero.",
    ]);
    expect(() => parseSingleQuestion(q, "Atom", 2, atomResearch, [])).toThrow(QualityCheckError);
  });
});

describe("parseSingleQuestion: questions must stand alone (no passage/source references)", () => {
  it("rejects a prompt that points at the grounding passage", () => {
    const q = json({
      prompt: "What does the term 'chemistry' mean as described in the passage?",
      options: ["The study of matter", "The study of light", "The study of sound", "The study of stars"],
      answer: 0,
      hint: "Think about what chemists study.",
      explanation: "Chemistry is the study of matter and its changes.",
    });
    expect(() => parseSingleQuestion(q, "Chemistry", 2, research, [])).toThrow(QualityCheckError);
  });

  it("rejects 'according to the provided text' prompts", () => {
    const q = json({
      prompt: "According to the provided text, which substance do plants produce?",
      options: ["Glucose", "Iron", "Granite", "Helium"],
      answer: 0,
      hint: "It is a sugar made during photosynthesis.",
      explanation: "Photosynthesis converts carbon dioxide and water into glucose.",
    });
    expect(() => parseSingleQuestion(q, "Photosynthesis", 2, research, [])).toThrow(QualityCheckError);
  });

  it("rejects prompts that name the source (e.g. Wiktionary/Wikipedia)", () => {
    const q = json({
      prompt: "What is the primary difference between the Latin and English meanings, as described in the Wiktionary entry?",
      options: ["The scope of study", "The spelling only", "The pronunciation only", "The alphabet used"],
      answer: 0,
      hint: "Consider how the field broadened over time.",
      explanation: "The English term covers a broader range of natural science.",
    });
    expect(() => parseSingleQuestion(q, "Chemistry", 2, research, [])).toThrow(QualityCheckError);
  });

  it("rejects paragraph-length options that only paraphrase each other", () => {
    const q = json({
      prompt: "What role does chlorophyll play in photosynthesis?",
      options: [
        "It is the green pigment inside the chloroplast that absorbs light energy and converts it into chemical energy used to drive the reactions that build glucose from carbon dioxide and water.",
        "It is the pigment that captures photons of sunlight so the plant can use that energy to make sugar and release oxygen into the surrounding air during the daylight hours.",
        "It is a molecule that takes in light and passes the energy along so that carbon dioxide and water can be assembled into glucose and oxygen by the plant.",
        "It is a light-harvesting compound that turns solar radiation into usable chemical power for producing glucose and releasing oxygen as a by-product.",
      ],
      answer: 0,
      hint: "Think about the pigment that captures light.",
      explanation: "Chlorophyll absorbs sunlight and provides the energy for photosynthesis.",
    });
    expect(() => parseSingleQuestion(q, "Photosynthesis", 2, research, [])).toThrow(QualityCheckError);
  });

  it("rejects four near-identical paraphrases even when each option is short", () => {
    const q = json({
      prompt: "What role does chlorophyll play in photosynthesis?",
      options: [
        "Chlorophyll absorbs light energy in the chloroplast.",
        "Chlorophyll captures light energy inside the chloroplast.",
        "Chlorophyll takes in light energy within the chloroplast.",
        "Chlorophyll gathers light energy in the chloroplast.",
      ],
      answer: 0,
      hint: "Think about the pigment that captures light.",
      explanation: "Chlorophyll absorbs sunlight and provides the energy for photosynthesis.",
    });
    expect(() => parseSingleQuestion(q, "Photosynthesis", 2, research, [])).toThrow(QualityCheckError);
  });

  it("rejects a short option that is contained in a longer one", () => {
    const q = json({
      prompt: "How did the Roman Republic expand its territories?",
      options: [
        "Through a combination of diplomacy and military conquest",
        "Through strategic alliances with other city-states",
        "By conquering neighboring cities and tribes",
        "By using a combination of diplomacy and military force to expand its territories",
      ],
      answer: 0,
      hint: "Consider both negotiation and armed force.",
      explanation: "Rome combined diplomacy with military power to expand.",
    });
    expect(() => parseSingleQuestion(q, "Ancient Rome", 2, research, [])).toThrow(QualityCheckError);
  });

  it("rejects four full-sentence restatements of the same explanation", () => {
    const q = json({
      prompt: "How does the Sun's gravitational pull cause objects in the solar system to orbit around it?",
      options: [
        "Gravity warps space-time around massive objects",
        "Gravity is what makes planets move in circles around the Sun",
        "The Sun's gravity pulls objects into a curved path",
        "The Sun's gravity is what keeps planets in orbit",
      ],
      answer: 1,
      hint: "Think about how mass bends the path of moving objects.",
      explanation: "The Sun's gravity curves the paths of planets, keeping them in orbit.",
    });
    expect(() => parseSingleQuestion(q, "Solar System", 2, research, [])).toThrow(QualityCheckError);
  });

  it("still accepts short options that share a word (four different answers)", () => {
    const q = json({
      prompt: "Which gas is released during photosynthesis?",
      options: ["Oxygen gas", "Nitrogen gas", "Methane gas", "Carbon dioxide gas"],
      answer: 0,
      hint: "It is the gas animals need to breathe.",
      explanation: "Photosynthesis converts carbon dioxide and water into glucose and oxygen.",
    });
    const parsed = parseSingleQuestion(q, "Photosynthesis", 2, research, []);
    expect(parsed.options).toEqual(["Oxygen gas", "Nitrogen gas", "Methane gas", "Carbon dioxide gas"]);
  });

  it("accepts a grounded subtopic question even when it never says the subject word", () => {
    const q = json({
      prompt: "Where inside a plant cell does chlorophyll absorb light?",
      options: ["Chloroplast", "Nucleus", "Vacuole", "Cell wall"],
      answer: 0,
      hint: "Think about the green organelle in plant cells.",
      explanation: "Chlorophyll sits inside the chloroplasts of plant cells, where it absorbs sunlight.",
    });
    const parsed = parseSingleQuestion(q, "Photosynthesis", 2, research, []);
    expect(parsed.options[parsed.answer]).toBe("Chloroplast");
  });

  it("still accepts a short, self-contained question with distinct options", () => {
    const q = json({
      prompt: "Where in the plant cell does photosynthesis occur?",
      options: ["In the chloroplast", "In the nucleus", "In the cell wall", "In the vacuole"],
      answer: 0,
      hint: "Think about the organelle that captures light.",
      explanation: "Photosynthesis occurs inside the chloroplasts of plant cells.",
    });
    const parsed = parseSingleQuestion(q, "Photosynthesis", 2, research, []);
    expect(parsed.prompt).toBe("Where in the plant cell does photosynthesis occur?");
    expect(parsed.options).toEqual(["In the chloroplast", "In the nucleus", "In the cell wall", "In the vacuole"]);
  });
});
