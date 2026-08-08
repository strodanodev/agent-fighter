export { FP, fp, fpMul, fpToPx, clamp, nextRand } from './fp.js';
export {
  Btn, ITEM_BITS, PUNCH_MASK, KICK_MASK, ATTACK_MASK, DIR_MASK,
  held, pressed, pressedAttacks, countBits,
} from './input.js';
export type { InputFrame, InputSource } from './input.js';
export {
  ENGINE_VERSION, STAGE, TICKS_PER_SEC, ROUND_SECONDS, TUNING,
  TUNING_DEFAULTS, applyTuning, resetTuning, CHAR_TUNING_KEYS,
  BUTTON_BITS, BUTTON_PRIORITY, loadCharacter,
} from './data.js';
export type {
  CharacterBundle, CharTuning, LoadedCharacter, MoveDef, MoveStep, HitboxDef, ProjectileDef,
  CancelEdge, Rect, GuardKind, MoveStance, MoveKind, MovePhase, ButtonName,
} from './data.js';
export { HIST_LEN, numpadDir, detectMotion, downTappedRecently } from './motion.js';
export { ANALOG } from './characters/analog.js';
export {
  Action, Phase, PROJECTILE_SLOTS, characters, setCharacters,
  createGameState, resetRound, snapshot, restore, serialize, stateHash,
} from './state.js';
export type { GameState, FighterState, ProjectileState, StageBounds } from './state.js';
export { step, debugBoxes, debugInfo } from './sim.js';
export type { DebugBox, DebugFighterInfo } from './sim.js';
export { SYS, spriteForFighter } from './anim.js';
export { Intent, createAi, aiPoll, AI_PERSONALITY_RANGES } from './ai.js';
export type { AiState, AiPersonality } from './ai.js';
export {
  ITEMS, ITEM_COST, ITEM_TIER_ODDS, ITEM_TIER_COLORS, ITEM_TIER_LABELS, itemById,
} from './items.js';
export { ITEM_SLOTS, setMatchItems } from './state.js';
export type { ItemDef, ItemEffect, ItemEffectKind, ItemTier } from './items.js';
export {
  AURA_LINES, AURA_LABELS, AURA_MIN, AURA_MAX, AURA_LINES_BY_RARITY,
  PET_RARITY_ODDS, PET_RARITY_COLORS, PET_RARITY_LABELS, PET_COST, PET_ROLL_TICKETS,
  PET_REGEN_PERIOD_TICKS, PET_CRIT_BONUS, PET_CRIT_FLASH_TICKS,
  NO_AURA, clampAura, auraIsEmpty, auraLines, auraLineText, PET_MOTIONS,
} from './pets.js';
export type { PetAura, PetAuraKind, PetDef, PetRarity, PetMotion } from './pets.js';
export { setMatchPets } from './state.js';
export {
  BOARD_W, BOARD_H, REGION_NAME, REGION_SKILL, REGION_CREDITS,
  EXIT_BONUS, EXIT_FIGHT_FLOOR,
  isFightNode, nodeById, successors, predecessors, isLegalMove,
  topoOrder, routeTo, pathTo, minFights, exitNodes, exitRoutes, boardCredits,
} from './arcade-map.js';
export type {
  Board, BoardAgent, BoardNode, BoardNodeKind, BoardRegion, BoardLoot, ExitTier,
  RouteStat,
} from './arcade-map.js';
export {
  generateBoard, validateBoard, validateAllTemplates, templateIds,
} from './arcade-board.js';
export type { GenerateOptions } from './arcade-board.js';
export {
  REPLAY_CODEC_VERSION, encodeLedger, decodeLedger, ledgerTicks,
  encodeInputTrack, decodeInputTrack, bytesToBase64Url, base64UrlToBytes,
  canonicalJson,
} from './replay.js';
export type { LedgerTracks } from './replay.js';
