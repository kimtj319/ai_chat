import { Router } from "express";
import { consolidateProhibitions } from "../chat/prohibitionDetect.js";
import {
  activeText,
  listItems,
  pendingCount,
  PROHIBITIONS_FILE_MAX_CHARS,
  PROHIBITIONS_LIMIT_CHARS,
  PROHIBITIONS_WARN_RATIO,
  ProhibitionsTooLargeError,
  readProhibitions,
  splitProhibitions,
  writeProhibitions,
} from "../storage/prohibitionsStore.js";

/**
 * 내 "하지 말 것" 목록. 늘 호출한 계정 자기 것만 다룬다 — 경로에 계정 id 가 없으므로
 * 남의 목록을 가리킬 방법 자체가 없다. 관리자도 예외가 아니다: 이 목록은 사람이
 * 자기 말투로 적는 메모에 가깝고, 관리자가 들여다볼 운영상의 이유가 없다.
 */
export const prohibitionsRouter = Router();

function summary(markdown: string) {
  return {
    markdown,
    activeChars: activeText(markdown).length,
    limitChars: PROHIBITIONS_LIMIT_CHARS,
    warnRatio: PROHIBITIONS_WARN_RATIO,
    fileMaxChars: PROHIBITIONS_FILE_MAX_CHARS,
    pendingCount: pendingCount(markdown),
  };
}

prohibitionsRouter.get("/prohibitions", async (req, res, next) => {
  try {
    res.json(summary(await readProhibitions(req.ownerId)));
  } catch (err) {
    next(err);
  }
});

prohibitionsRouter.put("/prohibitions", async (req, res, next) => {
  const markdown = (req.body as { markdown?: unknown } | undefined)?.markdown;
  if (typeof markdown !== "string") {
    res.status(400).json({ error: "markdown 이 문자열이어야 합니다." });
    return;
  }
  try {
    res.json(summary(await writeProhibitions(req.ownerId, markdown)));
  } catch (err) {
    if (err instanceof ProhibitionsTooLargeError) {
      res.status(413).json({ error: err.message });
      return;
    }
    next(err);
  }
});

/**
 * 반영 목록을 묶어 줄인 안을 돌려준다. 저장하지 않는다 — 합치다가 뜻이 바뀌는 일이
 * 있으므로 사용자가 보고 받아들일 때만 PUT 으로 들어간다. 정리 대상은 반영되는
 * 부분뿐이고, 검토 대기는 그대로 둔다.
 */
prohibitionsRouter.post("/prohibitions/consolidate", async (req, res, next) => {
  try {
    const markdown = await readProhibitions(req.ownerId);
    const items = listItems(splitProhibitions(markdown).active);
    if (items.length < 2) {
      res.status(409).json({ error: "묶을 항목이 두 개 이상 있어야 합니다." });
      return;
    }
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    const proposal = await consolidateProhibitions(items, controller.signal);
    if (!proposal) {
      res.status(502).json({ error: "정리안을 만들지 못했습니다. 잠시 뒤 다시 시도하세요." });
      return;
    }
    res.json({ proposal, before: items.length, after: proposal.split("\n").length });
  } catch (err) {
    next(err);
  }
});
