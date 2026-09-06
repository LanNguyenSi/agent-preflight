// Fixture "build" that ITSELF fails (round-2 review HIGH-2): a repo whose
// build genuinely does not compile right now, reproduced with a plain
// non-zero exit so the fixture has no external dependencies. Prints to
// stderr so the failure text is captured the same way a real compiler
// error would be, and is asserted reachable via the persisted log.
process.stderr.write("build error: intentional failure (fixture)\n");
process.exit(2);
