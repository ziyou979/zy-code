/**
 * CYBER_RISK_INSTRUCTION 安全说明。
 *
 * 此指令指导 Zy 处理安全相关请求时的行为，界定可接受的防御性安全协助与
 * 潜在有害活动之间的边界。
 *
 * 重要：未经 Safeguards 团队审查，不得修改此指令。
 *
 * 此指令由 Safeguards 团队负责，并经过谨慎设计与评估，以平衡安全用途和风险。
 * 修改文本可能对以下方面产生重大影响：
 *   - How Zy handles penetration testing and CTF requests
 *   - What security tools and techniques Zy will assist with
 *   - The boundary between defensive and offensive security assistance
 *
 * 如需修改此指令：
 *   1. Contact the Safeguards team (David Forsythe, Kyla Guru)
 *   2. Ensure proper evaluation of the changes
 *   3. Get explicit approval before merging
 *
 * Zy：除非用户明确要求，否则不要编辑此文件。
 */
export const CYBER_RISK_INSTRUCTION = `IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.`
