// 节点 ID 形态（r-mp6f）：工具以节点 ID 定位，ID 是 26 位完整 ULID，
// 不接受缩写或前缀匹配。未命中时由各操作在错误里回显传入值与所需形态。
// @sibom r-mp6f — 节点 ID 须为 26 位完整 ULID，未命中回显传入值与所需形态

/** 完整 ULID：26 位 Crockford Base32（与 ulidx 生成形态一致） */
export const FULL_ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** 回显用户输入的 ID 时限制长度，避免超长输入污染错误上下文 */
const ID_ECHO_MAX = 64;

export function echoId(id: string): string {
  return id.length > ID_ECHO_MAX ? `${id.slice(0, ID_ECHO_MAX - 3)}...` : id;
}

/** 实体 ID（节点/认领/提案）未命中提示：按形态给出所需形状 */
export function entityIdMissHint(id: string, label: string): string {
  if (FULL_ULID_RE.test(id)) return `（未命中；${label} ID 须为 26 位完整 ULID）`;
  if (id.length !== 26) return `（${label} ID 须为 26 位完整 ULID，不接受缩写或前缀匹配）`;
  return `（${label} ID 须为 26 位完整 Crockford Base32 ULID，字符集不含 I/L/O/U 且区分大小写）`;
}

/** 未命中提示：合法形态说明未命中；长度不足指出不接受缩写/前缀；字符集非法指出 Crockford 形态 */
export function nodeIdMissHint(id: string): string {
  return entityIdMissHint(id, '节点');
}
