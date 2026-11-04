import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { CrossChannelEchoFilter } = await import(
  pathToFileURL(path.resolve(__dirname, '../../../dist-electron/electron/audio/CrossChannelEchoFilter.js')).href
);

test('drops a mic segment that is only the meeting audio', () => {
  const f = new CrossChannelEchoFilter();
  f.noteInterviewer("That's great. That's great. So did you get the chance to lead the team, or you are like working as an individual contributor", 1000);
  assert.equal(
    f.filterUser("That's great. That's great. So did you get the chance to lead the team or you were like working as an individual? Manager.", 2000),
    '',
  );
});

test('keeps the user own words when the echo is fused into the segment', () => {
  const f = new CrossChannelEchoFilter();
  f.noteInterviewer("So Aman, let's start with your brief introduction. And I just hope that you already are aware about the job requirement", 1000);
  const out = f.filterUser("I'm great. Thanks for asking. So Aman, let's start. with your brief introduction and i just hope that you already are", 2000);
  assert.match(out, /great/);
  assert.doesNotMatch(out, /brief introduction/);
});

test('leaves the user speech alone when the interviewer said something else', () => {
  const f = new CrossChannelEchoFilter();
  f.noteInterviewer('What is the difference between group by and where clause', 1000);
  const text = 'I worked with microservices for four years in backend development';
  assert.equal(f.filterUser(text, 2000), text);
});

test('a short repeat of the question is not stripped from a longer answer', () => {
  const f = new CrossChannelEchoFilter();
  f.noteInterviewer('What is Python', 1000);
  const text = 'What is Python it is a high level language used for scripting and backend work';
  assert.equal(f.filterUser(text, 2000), text);
});

test('forgets interviewer text after the window', () => {
  const f = new CrossChannelEchoFilter();
  f.noteInterviewer('let us start with your brief introduction please', 1000);
  const text = 'let us start with your brief introduction please';
  assert.equal(f.filterUser(text, 1000 + 25_000), text);
});
