/**
 * Words for the help desk's kinds and statuses.
 *
 * In a plain module rather than beside the forms: a value exported from a
 * 'use client' file reaches a server component as a reference, not the object,
 * and the labels came out blank.
 */

export const KIND_LABEL: Record<string, string> = {
  QUESTION: 'Question',
  PROBLEM: 'Something is wrong',
  IDEA: 'Idea or request',
};

export const STATUS_LABEL: Record<string, string> = {
  OPEN: 'Waiting on RelaStack',
  WAITING_ON_CUSTOMER: 'Replied',
  RESOLVED: 'Resolved',
};
