AI usage policy
===============

This policy draws from both [Fedify's AI usage policy][0], which was inspired
by [Ghostty's AI policy][1], and
[NLnet's policy on the use of Generative Artificial Intelligence][2].

In this policy, *AI* means generative AI tools such as large language models
and code assistants.  It does not include deterministic code generation,
static analysis, fuzz testing, or other forms of automation.

The DrFed project has the following rules for AI usage:

 -  *All AI assistance must be disclosed.*  You must state the tool you used
    (e.g., Claude, Cursor, GitHub Copilot) and the extent of its assistance in
    your pull request description.  Every assisted commit must include an
    `Assisted-by` trailer.  Substantive assistance must also be described in
    the commit body as explained below.

 -  *Pull requests created in any way by AI can only be for accepted issues.*
    Drive-by pull requests that do not reference an accepted issue will be
    closed.  If AI isn't disclosed but a maintainer suspects its use, the PR
    will be closed.  If you want to share code for a non-accepted issue, open
    a discussion or attach it to an existing discussion.

 -  *AI-assisted contributions must be understood and verified by a human.*
    Contributors must review the work, understand and be able to explain its
    design and code decisions, and remain able to fix it themselves.  They are
    responsible for its accuracy, originality, integration, and
    reproducibility.  Contributors must not submit hypothetically correct code
    that has not been tested, nor may they submit code for platforms or
    environments they cannot manually test.

 -  *AI-assisted outputs must be suitable for publication under DrFed's
    license.*  Contributors must check that generated output does not reproduce
    copyrighted or license-incompatible material and that the AI tool's terms
    allow the output to be used.  Output generated entirely by AI without
    substantial human intellectual contribution must not be submitted as work
    eligible for payment under an NLnet grant.

 -  *Issues and discussions can use AI assistance but must have a full
    human-in-the-loop.*  This means that any content generated with AI must
    have been reviewed and edited by a human before submission.  AI is very
    good at being overly verbose and including noise that distracts from
    the main point.  Humans must do their research and trim this down.

 -  *AI-generated media (images, diagrams, etc.) is allowed only in
    documentation, and must be clearly labeled as AI-generated.*  Text and
    code are acceptable AI-generated content per the other rules in this
    policy.  For documentation visuals like diagrams or illustrations,
    AI-generated content is permitted but must include clear attribution
    (e.g., “Diagram generated with DALL-E” or “Created using Midjourney”).

 -  *Violations of this policy may result in being banned from contributing.*
    We want to help contributors learn and grow, but repeated or intentional
    violations of this policy undermine trust and burden maintainers.

The rules concerning accepted issues and contribution bans apply only to
outside contributions to DrFed.  Maintainers may use AI tools at their
discretion when deciding what work to undertake, but they are not exempt from
the disclosure, human verification, attribution, or licensing requirements
above.

[0]: https://github.com/fedify-dev/fedify/blob/main/AI_POLICY.md
[1]: https://github.com/ghostty-org/ghostty/blob/main/AI_POLICY.md
[2]: https://nlnet.nl/foundation/policies/generativeAI/


Disclosing AI assistance in commit messages
-------------------------------------------

When AI tools assist with a commit, add an `Assisted-by` trailer to the commit
message.  Do *not* use `Co-authored-by` for AI assistants; that trailer is
reserved for human co-authors.

When AI use materially affects the contents of a commit, the commit message
body must also include an English provenance note.  The note does not need to
quote the original prompts, interactions, or outputs verbatim.  It must
faithfully summarize:

 -  what the contributor asked the tool to do;
 -  how the interaction shaped the result and what the tool generated;
 -  any significant decisions or changes made by the human contributor; and
 -  how the contributor verified the result.

This requirement follows [NLnet's policy on the use of GenAI][2], which allows
the prompts, interactions, and resulting output to be recorded as a summary.
Do not put secrets, personal data, or confidential information in prompts or
provenance notes.  A summary must still disclose the material extent of the
AI's contribution.

The trailer format is:

~~~~
Assisted-by: AGENT_NAME:MODEL_VERSION
~~~~

For example:

~~~~
Assisted-by: OpenCode:qwen3.6-plus
Assisted-by: Claude Code:claude-sonnet-5
Assisted-by: Antigravity:gemini-3.7-flash
Assisted-by: Codex:gpt-5.6-sol
Assisted-by: Codex:gpt-6-astra
~~~~

If multiple AI tools were used, include one `Assisted-by` line per tool.


There are humans here
---------------------

Please remember that DrFed is maintained by humans.

Every discussion, issue, and pull request is read and reviewed by humans
(and sometimes machines, too).  It is a boundary point at which people interact
with each other and the work done.  It is rude and disrespectful to approach
this boundary with low-effort, unqualified work, since it puts the burden of
validation on the maintainer.

In a perfect world, AI would produce high-quality, accurate work every time.
But today, that reality depends on the driver of the AI.  And today, most
drivers of AI are just not good enough.  So, until either the people get
better, the AI gets better, or both, we have to have rules to protect
maintainers.


AI is welcome here
------------------

DrFed is developed with AI assistance.  Maintainers may use AI for planning,
implementation, refactoring, testing, documentation, debugging, and review.
The extent of that assistance is disclosed in pull requests and commit
messages under the rules above.

*Our reason for this policy is not due to an anti-AI stance*, but instead due
to the number of highly unqualified people using AI.  It's the people, not
the tools, that are the problem.

We include this section to be transparent about the project's usage of AI for
people who may disagree with it, and to address the misconception that this
policy is anti-AI in nature.
