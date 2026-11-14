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
