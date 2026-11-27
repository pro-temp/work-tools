import { readFileSync } from 'node:fs';
import { isMainModule } from './slots.mjs';

function matchesType(value, expectedType) {
  if (expectedType === 'null') return value === null;
  if (expectedType === 'array') return Array.isArray(value);
  if (expectedType === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (expectedType === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (expectedType === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (expectedType === 'string') return typeof value === 'string';
  if (expectedType === 'boolean') return typeof value === 'boolean';
  return true;
}

function validateNode(value, schema, pathStr, errors) {
  if (!schema || typeof schema !== 'object') return;

  if (Array.isArray(schema.anyOf)) {
    const anyPassed = schema.anyOf.some((branch) => {
      const subErrors = [];
      validateNode(value, branch, pathStr, subErrors);
      return subErrors.length === 0;
    });
    if (!anyPassed) {
      errors.push(`${pathStr}: value does not match any allowed schema branch.`);
    }
    return;
  }

  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!allowed.some((t) => matchesType(value, t))) {
      errors.push(`${pathStr}: expected type ${allowed.join('|')}, got ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}.`);
      return;
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${pathStr}: expected one of [${schema.enum.join(', ')}], got ${JSON.stringify(value)}.`);
    return;
  }

  if (matchesType(value, 'object')) {
    if (Array.isArray(schema.required)) {
      for (const req of schema.required) {
        if (!Object.prototype.hasOwnProperty.call(value, req)) {
          errors.push(`${pathStr}: missing required property "${req}".`);
        }
      }
    }
    const props = schema.properties || {};
    for (const [k, v] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(props, k)) {
        validateNode(v, props[k], `${pathStr}.${k}`, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${pathStr}.${k}: unexpected property (additionalProperties is false).`);
      }
    }
  } else if (matchesType(value, 'array') && schema.items) {
    for (let i = 0; i < value.length; i++) {
      validateNode(value[i], schema.items, `${pathStr}[${i}]`, errors);
    }
  }
}

export function validateHandoff(handoff, schema, taskKind = 'implement') {
  const errors = [];
  const normKind = String(taskKind || 'implement').toLowerCase();
  validateNode(handoff, schema, '$', errors);

  if (errors.length === 0) {
    if (handoff.status === 'done') {
      if (handoff.questions.length > 0) {
        errors.push('Invalid handoff: status is "done" but "questions" is non-empty.');
      }
      if (handoff.permission_request !== null) {
        errors.push('Invalid handoff: status is "done" but "permission_request" is non-null.');
      }
    } else if (handoff.status === 'needs_input') {
      if (handoff.questions.length === 0) {
        errors.push('Invalid handoff: status is "needs_input" but "questions" is empty.');
      }
      if (handoff.permission_request !== null) {
        errors.push('Invalid handoff: status is "needs_input" but "permission_request" is non-null.');
      }
    } else if (handoff.status === 'needs_permission') {
      if (handoff.permission_request === null) {
        errors.push('Invalid handoff: status is "needs_permission" but "permission_request" is null.');
      }
      if (handoff.questions.length > 0) {
        errors.push('Invalid handoff: status is "needs_permission" but "questions" is non-empty.');
      }
    }

    if ((normKind === 'plan' || normKind === 'review') && handoff.changed_files.length > 0) {
      errors.push(`Invalid handoff: TaskKind '${normKind}' is read-only but 'changed_files' is non-empty.`);
    }
  }

  return { valid: errors.length === 0, errors };
}

if (isMainModule(import.meta.url)) {
  try {
    const [, , handoffPath, schemaPath, taskKind = 'implement'] = process.argv;
    const handoff = JSON.parse(readFileSync(handoffPath, 'utf8'));
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
    const res = validateHandoff(handoff, schema, taskKind);
    process.stdout.write(`${JSON.stringify(res)}\n`);
    process.exit(res.valid ? 0 : 1);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ valid: false, errors: [err.message] })}\n`);
    process.exit(1);
  }
}
