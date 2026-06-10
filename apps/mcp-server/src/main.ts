#!/usr/bin/env node
/**
 * morphit-mcp — Model Context Protocol server for Morphit.
 *
 * Speaks the MCP stdio protocol so any MCP-compatible AI agent
 * (Claude Desktop, Cline, Cursor, Continue, Windsurf, Zed,
 * or anything built on @modelcontextprotocol/sdk) can call into
 * Morphit's federated orderbook directly.
 *
 * Configuration: a single env var, MORPHIT_MCP_INSTANCE_URL,
 * pointing at whichever Morphit instance the user wants to query
 * (defaults to https://morphit.io).
 *
 * Read-only.  No keys.  No signing.  All write actions are handed
 * off to the Morphit web UI via deeplinks returned alongside tool
 * results.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
	CallToolRequestSchema,
	ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import {
	SEARCH_ORDERS_DESCRIPTION,
	SearchOrdersInputSchema,
	searchOrders
} from './tools/searchOrders.js';
import {
	LIST_INSTANCES_DESCRIPTION,
	ListInstancesInputSchema,
	listInstances
} from './tools/listInstances.js';
import {
	LIST_PAYMENT_METHODS_DESCRIPTION,
	ListPaymentMethodsInputSchema,
	listPaymentMethods
} from './tools/listPaymentMethods.js';
import {
	GET_LISTING_DESCRIPTION,
	GetListingInputSchema,
	getListing
} from './tools/getListing.js';
import {
	DESCRIBE_DESCRIPTION,
	DescribeInputSchema,
	describeMorphit
} from './tools/describeMorphit.js';

/** Convert a Zod schema to JSON Schema for MCP's tool advertisement.
 *  Use a minimal hand-rolled converter rather than pulling in
 *  zod-to-json-schema; the surface is small enough that this
 *  costs ~30 lines and saves a dependency.
 *
 *  Honours: object, string (+regex, min/max), number (+int, min/max),
 *  boolean, enum, optional, describe(). */
function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
	if (schema instanceof z.ZodObject) {
		const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
		const props: Record<string, unknown> = {};
		const required: string[] = [];
		for (const [key, value] of Object.entries(shape)) {
			const inner = value as z.ZodTypeAny;
			props[key] = zodToJsonSchema(inner);
			if (!inner.isOptional()) required.push(key);
		}
		const out: Record<string, unknown> = {
			type: 'object',
			properties: props
		};
		if (required.length > 0) out.required = required;
		return out;
	}
	if (schema instanceof z.ZodOptional) {
		return zodToJsonSchema((schema as z.ZodOptional<z.ZodTypeAny>).unwrap());
	}
	if (schema instanceof z.ZodString) {
		const out: Record<string, unknown> = { type: 'string' };
		const desc = schema.description;
		if (desc) out.description = desc;
		return out;
	}
	if (schema instanceof z.ZodNumber) {
		const out: Record<string, unknown> = { type: 'number' };
		const desc = schema.description;
		if (desc) out.description = desc;
		return out;
	}
	if (schema instanceof z.ZodBoolean) {
		const out: Record<string, unknown> = { type: 'boolean' };
		const desc = schema.description;
		if (desc) out.description = desc;
		return out;
	}
	if (schema instanceof z.ZodEnum) {
		const e = schema as z.ZodEnum<[string, ...string[]]>;
		const out: Record<string, unknown> = { type: 'string', enum: e.options };
		const desc = schema.description;
		if (desc) out.description = desc;
		return out;
	}
	// Fallback — accept anything, let the Zod parse step do the
	// actual validation.
	return {};
}

/** Tool registry — pairs the MCP-advertised schema with the
 *  handler.  Keep the names stable; AI agent tool-selection logic
 *  may key off them. */
interface ToolRegistration<I extends z.ZodTypeAny> {
	name: string;
	description: string;
	inputSchema: I;
	handler: (input: z.infer<I>) => Promise<unknown>;
}

const TOOLS: ToolRegistration<z.ZodTypeAny>[] = [
	{
		name: 'morphit_search_orders',
		description: SEARCH_ORDERS_DESCRIPTION,
		inputSchema: SearchOrdersInputSchema,
		handler: searchOrders
	},
	{
		name: 'morphit_list_instances',
		description: LIST_INSTANCES_DESCRIPTION,
		inputSchema: ListInstancesInputSchema,
		handler: listInstances
	},
	{
		name: 'morphit_list_payment_methods',
		description: LIST_PAYMENT_METHODS_DESCRIPTION,
		inputSchema: ListPaymentMethodsInputSchema,
		handler: listPaymentMethods
	},
	{
		name: 'morphit_get_listing',
		description: GET_LISTING_DESCRIPTION,
		inputSchema: GetListingInputSchema,
		handler: getListing
	},
	{
		name: 'morphit_describe',
		description: DESCRIBE_DESCRIPTION,
		inputSchema: DescribeInputSchema,
		handler: describeMorphit
	}
];

async function main() {
	const server = new Server(
		{
			name: 'morphit-mcp',
			version: '1.0.0-beta.9'
		},
		{
			capabilities: {
				tools: {}
			}
		}
	);

	// Advertise tools.
	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: TOOLS.map((t) => ({
			name: t.name,
			description: t.description,
			inputSchema: zodToJsonSchema(t.inputSchema)
		}))
	}));

	// Handle tool calls.  Validate input via Zod, run handler,
	// return JSON-stringified result.  All errors surface back to
	// the agent as a tool-call error rather than crashing the
	// server — agents present these to the user as "the tool
	// errored, here's why."
	server.setRequestHandler(CallToolRequestSchema, async (req) => {
		const tool = TOOLS.find((t) => t.name === req.params.name);
		if (!tool) {
			return {
				isError: true,
				content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }]
			};
		}
		try {
			const parsed = tool.inputSchema.parse(req.params.arguments ?? {});
			const result = await tool.handler(parsed);
			return {
				content: [
					{
						type: 'text',
						text: JSON.stringify(result, null, 2)
					}
				]
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return {
				isError: true,
				content: [{ type: 'text', text: `Tool error: ${msg}` }]
			};
		}
	});

	const transport = new StdioServerTransport();
	await server.connect(transport);
	// Stay alive until stdio closes — the SDK handles the loop.
}

main().catch((err) => {
	// Last-resort error path. stderr is captured by the MCP client
	// and shown to the user.
	process.stderr.write(`morphit-mcp fatal: ${err instanceof Error ? err.message : String(err)}\n`);
	process.exit(1);
});
