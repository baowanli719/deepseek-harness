/** Local structured DOCX authoring without scripts, network access, or ACL edits. */
import type { Context } from '@deepseek-ai/cordis'
import { constants } from 'node:fs'
import { copyFile, realpath, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun } from 'docx'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-sandbox-policy'

/** Loader plugin identity. */
export const name = 'gs-word-document'
/** Tool dispatch and effective enterprise filesystem policy. */
export const inject = ['tools', 'sandboxPolicy']

/**
 * Register a local-only document creator available in private sessions.
 * Creates new files in existing directories under the selected file policy; existing files are never replaced.
 * @param ctx - owning tool registry and policy services.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'create_word_document',
    description: 'Create a local Word .docx from a title, paragraphs and optional tables. Works in private sessions without PowerShell, Python, network access or ACL changes. The output must be a new file in an existing directory; workspace-write confines it to the workspace and full access permits external paths. Use this tool for Word deliverables, then present the resulting file. Does not edit existing documents or render a preview.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'New .docx path allowed by the current file policy.' },
      title: { type: 'string', required: true, description: 'Document title.' },
      paragraphs: { type: 'array', required: true, items: { type: 'string' }, description: 'Body paragraphs in order; newline characters become line breaks.' },
      tables: { type: 'array', items: { type: 'array', items: { type: 'array', items: { type: 'string' } } }, description: 'Optional tables, each containing rows of cell text. Every row in a table must have the same number of cells.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: `Created Word document: ${value.path}` }],
    },
    async execute(args, exec) {
      const policy = ctx.sandboxPolicy.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })
      if (policy.mode === 'read-only') throw new Error('Word document creation is denied under read-only mode.')
      if (!args.file_path.trim() || extname(args.file_path).toLowerCase() !== '.docx') throw new Error('file_path must name a .docx file.')
      const root = await realpath(policy.workspaceRoot)
      const requested = resolve(root, args.file_path)
      const parent = await realpath(dirname(requested))
      const child = relative(root, parent)
      if (policy.mode !== 'danger-full-access' && (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child))) {
        throw new Error('Word document output must be inside the current workspace under workspace-write mode.')
      }
      const path = join(parent, basename(requested))
      const tables = (args.tables ?? []).map((rows) => {
        if (!rows.length || !rows[0]?.length || rows.some(row => row.length !== rows[0]?.length)) {
          throw new Error('Tables must contain non-empty rows with equal cell counts.')
        }
        return new Table({ rows: rows.map(row => new TableRow({
          children: row.map(text => new TableCell({ children: [new Paragraph(text)] })),
        })) })
      })
      const document = new Document({
        styles: { default: { document: { run: { font: 'Microsoft YaHei', size: 22 }, paragraph: { spacing: { after: 160 } } } } },
        sections: [{ children: [
          new Paragraph({ text: args.title, heading: HeadingLevel.TITLE }),
          ...args.paragraphs.map(text => new Paragraph({
            children: text.split(/\r?\n/u).map((line, index) => new TextRun({ text: line, break: index === 0 ? 0 : 1 })),
          })),
          ...tables,
        ] }],
      })
      const bytes = await Packer.toBuffer(document)
      exec.signal.throwIfAborted()
      const temporary = join(parent, `.dsh-word-${randomUUID()}.tmp`)
      try {
        await writeFile(temporary, bytes, { flag: 'wx', signal: exec.signal })
        exec.signal.throwIfAborted()
        // Exclusive copying supports volumes without hard links and refuses existing destinations.
        await copyFile(temporary, path, constants.COPYFILE_EXCL)
      } finally {
        // force ignores an already-cleaned temporary and still surfaces real cleanup failures.
        await rm(temporary, { force: true })
      }
      return { path }
    },
    presentCall: args => ({ card: 'generic', title: `Create Word: ${args.file_path}` }),
  }))
}
