import { describe, it, expect } from 'vitest';
import { buildCommentOptionsOperation } from './comment';

/**
 * comment_options — v1.8.12 (Ken): "we really want as much liquid BLURT as
 * possible to go to the user/author."
 *
 * Morphit never broadcast this op, so every syndicated post took Blurt's
 * default 25% liquid / 75% BP author split. What is provable HERE is the op's
 * SHAPE: it is serialised with dblurt's own serializer, which throws on any
 * field-name or type mismatch, so a valid serialisation means the chain will
 * parse it. Whether consensus ACCEPTS percent_blurt = 10000 (rather than
 * clamping or refusing) cannot be established offline — which is precisely why
 * the op is broadcast in its own transaction, so a refusal costs the reward
 * split and never the post.
 */
describe('comment_options op', () => {
	it('serialises against dblurt without throwing (shape is chain-valid)', async () => {
		const { Types } = await import('@beblurt/dblurt');
		const ByteBuffer = (await import('bytebuffer')).default;
		const op = buildCommentOptionsOperation('kencode', 'my-post');
		const buf = new ByteBuffer(ByteBuffer.DEFAULT_CAPACITY, ByteBuffer.LITTLE_ENDIAN);
		// Throws if any field name/type mismatches the chain's expected layout.
		expect(() => Types.Operation(buf, op as never)).not.toThrow();
		// Serialising without throwing is the assertion; dblurt rejects any
		// field-name or type mismatch, so a clean pass means the chain will parse it.
	});

	it('asks for maximum liquid and sets NO beneficiaries', () => {
		const [name, data] = buildCommentOptionsOperation('kencode', 'my-post');
		expect(name).toBe('comment_options');
		// percent_blurt is StaticVariant index 1; beneficiaries is index 0.
		expect(data.extensions).toEqual([[1, { percent_blurt: 10000 }]]);
		const ext = data.extensions as Array<[number, unknown]>;
		expect(ext.some(([idx]) => idx === 0)).toBe(false); // no beneficiaries
		expect(data.allow_curation_rewards).toBe(true);
		expect(data.allow_votes).toBe(true);
	});
});
