import { createHash } from "node:crypto";
import type { EmbeddingPort } from "./types.js";

/**
 * 确定性假 embedder：字符 bigram 哈希词袋。共享子串越多，余弦越高。
 * 只用于离线测试与开发，不代表真实语义质量。
 */
export class FakeEmbedder implements EmbeddingPort {
  public constructor(private readonly dimensions = 64) {}

  public async embed(
    texts: readonly string[],
  ): Promise<ReadonlyArray<readonly number[]>> {
    return texts.map((text) => this.vector(text));
  }

  private vector(text: string): number[] {
    const vector = new Array<number>(this.dimensions).fill(0);
    for (let index = 0; index < text.length; index += 1) {
      const gram = text.slice(index, index + 2);
      const digest = createHash("sha256").update(gram).digest();
      const bucket = ((digest[0]! << 8) | digest[1]!) % this.dimensions;
      vector[bucket]! += 1;
    }
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    return norm === 0 ? vector : vector.map((value) => value / norm);
  }
}
