/**
 * Minimal, dependency-free XML support for the MOCA `application/moca-xml` protocol.
 *
 * The MOCA server accepts a `<moca-request>` document and answers with a
 * `<moca-response>` document, so a full XML library would be overkill. Keeping this
 * self-contained also keeps the published package free of runtime dependencies.
 */

export interface XmlNode {
	name: string;
	attributes: Record<string, string>;
	children: XmlNode[];
	/** Concatenated text (and CDATA) content directly owned by this element. */
	text: string;
	/** `false` when the element carried no text nodes at all, which MOCA uses for NULL. */
	hasText: boolean;
}

const NAMED_ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
};

/**
 * Escapes element text. Only `&`, `<` and `>` are encoded, which matches the escaping
 * the reference MOCA clients emit - quotes are left alone so MOCA string literals stay
 * readable in the command that reaches the server.
 */
export function escapeXmlText(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Escapes a value for use inside a double quoted attribute. */
export function escapeXmlAttribute(value: string): string {
	return escapeXmlText(value).replace(/"/g, '&quot;');
}

export function decodeXmlEntities(value: string): string {
	return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
		if (entity.startsWith('#x') || entity.startsWith('#X')) {
			const code = Number.parseInt(entity.slice(2), 16);
			return Number.isNaN(code) ? match : String.fromCodePoint(code);
		}
		if (entity.startsWith('#')) {
			const code = Number.parseInt(entity.slice(1), 10);
			return Number.isNaN(code) ? match : String.fromCodePoint(code);
		}
		const named = NAMED_ENTITIES[entity];
		return named === undefined ? match : named;
	});
}

function createNode(name: string): XmlNode {
	return { name, attributes: {}, children: [], text: '', hasText: false };
}

function addText(node: XmlNode, raw: string, decode: boolean): void {
	if (raw === '') return;
	node.text += decode ? decodeXmlEntities(raw) : raw;
	node.hasText = true;
}

/** Finds the `>` that closes a tag, ignoring any `>` inside quoted attribute values. */
function findTagEnd(input: string, start: number): number {
	let quote: string | null = null;
	for (let i = start; i < input.length; i++) {
		const char = input[i];
		if (quote !== null) {
			if (char === quote) quote = null;
		} else if (char === '"' || char === "'") {
			quote = char;
		} else if (char === '>') {
			return i;
		}
	}
	return -1;
}

function parseAttributes(source: string, node: XmlNode): void {
	const pattern = /([^\s=/<>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
	let match = pattern.exec(source);
	while (match !== null) {
		const value = match[3] !== undefined ? match[3] : (match[4] ?? '');
		node.attributes[match[1]] = decodeXmlEntities(value);
		match = pattern.exec(source);
	}
}

/**
 * Parses an XML document into a tree. The returned node is a synthetic `#document`
 * root whose children are the top level elements.
 */
export function parseXml(input: string): XmlNode {
	const root = createNode('#document');
	const stack: XmlNode[] = [root];
	let index = 0;

	while (index < input.length) {
		const current = stack[stack.length - 1];
		const open = input.indexOf('<', index);

		if (open === -1) {
			addText(current, input.slice(index), true);
			break;
		}
		if (open > index) {
			addText(current, input.slice(index, open), true);
		}

		if (input.startsWith('<!--', open)) {
			const end = input.indexOf('-->', open);
			index = end === -1 ? input.length : end + 3;
			continue;
		}
		if (input.startsWith('<![CDATA[', open)) {
			const end = input.indexOf(']]>', open);
			addText(current, input.slice(open + 9, end === -1 ? input.length : end), false);
			index = end === -1 ? input.length : end + 3;
			continue;
		}
		if (input.startsWith('<?', open)) {
			const end = input.indexOf('?>', open);
			index = end === -1 ? input.length : end + 2;
			continue;
		}
		if (input.startsWith('<!', open)) {
			const end = findTagEnd(input, open);
			index = end === -1 ? input.length : end + 1;
			continue;
		}

		const tagEnd = findTagEnd(input, open);
		if (tagEnd === -1) {
			// Truncated document - keep whatever was parsed so far.
			break;
		}
		const tagBody = input.slice(open + 1, tagEnd);

		if (tagBody.startsWith('/')) {
			const name = tagBody.slice(1).trim();
			for (let depth = stack.length - 1; depth > 0; depth--) {
				if (stack[depth].name === name) {
					stack.length = depth;
					break;
				}
			}
			index = tagEnd + 1;
			continue;
		}

		const selfClosing = tagBody.endsWith('/');
		const inner = selfClosing ? tagBody.slice(0, -1) : tagBody;
		const nameMatch = /^([^\s/>]+)/.exec(inner);
		if (nameMatch === null) {
			index = tagEnd + 1;
			continue;
		}

		const node = createNode(nameMatch[1]);
		parseAttributes(inner.slice(nameMatch[1].length), node);
		current.children.push(node);
		if (!selfClosing) stack.push(node);
		index = tagEnd + 1;
	}

	return root;
}

export function findChild(node: XmlNode, name: string): XmlNode | undefined {
	return node.children.find((child) => child.name === name);
}

export function findDescendant(node: XmlNode, name: string): XmlNode | undefined {
	for (const child of node.children) {
		if (child.name === name) return child;
		const nested = findDescendant(child, name);
		if (nested !== undefined) return nested;
	}
	return undefined;
}

export function findChildren(node: XmlNode, name: string): XmlNode[] {
	return node.children.filter((child) => child.name === name);
}
