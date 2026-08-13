/**
 * New-file templates.
 *
 * Each one follows the corresponding sample in the plugin's own `DFX/` folder -- same module set,
 * same body shape -- deliberately, not for want of imagination: those four files are in the corpus
 * suite, so their shape is known to build, and a template invented from the documentation would
 * only be *believed* to.
 *
 * All four were then built for real (`dfx build <file> -NoSave`) rather than assumed, which is how
 * the comment that used to sit inside the DynamicInput body was found: the compiler reduced that
 * body to one expression by looking for a leading `return` to strip, and a `//` line in front of it
 * defeated the test -- so the `return` survived into `Out_X = (float)( return ... );`, which is not
 * an expression. A *Module* body is emitted verbatim and never wrapped, so the same comment there
 * was always fine.
 *
 * Fixed in the plugin as of 2026-08-13: the reduction strips comments first, so a comment in a
 * DynamicInput body is trivia the way it reads. These templates keep their commentary outside the
 * block anyway -- a template should not depend on the newest version of the thing it is a template
 * for -- and a test holds that line.
 */

export type TemplateKind = 'system' | 'emitter' | 'module' | 'dynamicInput';

export interface TemplateChoice {
	kind: TemplateKind;
	/** The `System` / `Emitter` / `Module` / `DynamicInput` keyword the file opens with. */
	keyword: string;
	label: string;
	description: string;
	extension: '.dfs' | '.dfe' | '.dfm';
	/** Suggested leading characters for the file name, matching the samples' convention. */
	namePrefix: string;
}

export const TEMPLATE_CHOICES: readonly TemplateChoice[] = [
	{
		kind: 'system',
		keyword: 'System',
		label: 'System (.dfs)',
		description: 'One UNiagaraSystem: emitters, renderers and the two system-scope stacks.',
		extension: '.dfs',
		namePrefix: 'NS_',
	},
	{
		kind: 'emitter',
		keyword: 'Emitter',
		label: 'Emitter (.dfe)',
		description: 'A reusable emitter, pulled into a system with `Emitter <Name> from "..."`.',
		extension: '.dfe',
		namePrefix: 'E_',
	},
	{
		kind: 'module',
		keyword: 'Module',
		label: 'Module (.dfm)',
		description: 'A UNiagaraScript for a stack: statements, named inputs, reuse by name.',
		extension: '.dfm',
		namePrefix: 'M_',
	},
	{
		kind: 'dynamicInput',
		keyword: 'DynamicInput',
		label: 'Dynamic input (.dfm)',
		description: 'A UNiagaraScript that computes one value for an input slot.',
		extension: '.dfm',
		namePrefix: 'DI_',
	},
];

export interface TemplateRequest {
	kind: TemplateKind;
	/** The asset path under the root, e.g. `Samples/NS_Spark`. */
	name: string;
	/** `Game`, empty, or `Plugin.<PluginName>`. */
	root: string;
}

export function renderTemplate(request: TemplateRequest): string {
	const header = `${keywordFor(request.kind)}(Name="${request.name}", Root="${request.root}")`;

	switch (request.kind) {
		case 'system':
			return `${header}
{
    Emitter Main
    {
        EmitterUpdate = {
            EmitterState();
            SpawnBurst_Instantaneous(SpawnCount = 24, SpawnTime = 0.0);
        }

        ParticleSpawn = {
            SystemLocation(Offset = (0, 0, 0));
        }

        ParticleUpdate = {
            GravityForce(Gravity = (0, 0, -680));
            SolveForcesAndVelocity();
        }

        SpriteRenderer Core
        {
        }
    }
}
`;

		case 'emitter':
			return `${header}
{
    Settings = {
        SimTarget          = CPU;
        LocalSpace         = true;
        AllocationMode     = Fixed;
        PreAllocationCount = 8;
    }

    EmitterUpdate = {
        EmitterState(LifeCycleMode = Self, LoopBehavior = Once, LoopDuration = 0.12);
        SpawnBurst_Instantaneous(SpawnCount = 1);
    }

    ParticleSpawn = {
        // V2: the plain Spawn/Initialization/InitializeParticle is deprecated (DFX6004).
        Spawn/Initialization/V2/InitializeParticle(
            LifetimeMode      = DirectSet,
            Lifetime          = 0.12,
            SpriteSizeMode    = Uniform,
            UniformSpriteSize = 48.0
        );
        SystemLocation();
    }

    ParticleUpdate = {
        // ParticleState provides UpdateAge, which anything reading NormalizedAge depends on.
        ParticleState();
    }

    SpriteRenderer Card
    {
        Alignment  = Unaligned;
        FacingMode = FaceCamera;
    }
}
`;

		case 'module':
			return `${header}
{
    Settings = {
        Usage       = ParticleUpdate;
        Category    = "DreamFX|Custom";
        Description = "";
    }

    Inputs = {
        float Amount = 1.0 [ Description="" ];
    }

    Body = {
        // Bare names are this module's own inputs; anything namespaced is read off the parameter map.
        Particles.SpriteRotation += Amount * Engine.DeltaTime;
    }
}
`;

		case 'dynamicInput':
			return `${header}
{
    Settings = {
        Usage    = DynamicInput;
        Output   = float;
        Category = "DreamFX|Custom";
    }

    Inputs = {
        float Frequency = 6.0;
    }

    // One expression, with or without the return: the body is written into
    // Output = (Type)( <body> ). Multi-statement logic belongs in a Module.
    Body = {
        return 0.5 + 0.5 * sin(Engine.Time * Frequency * 6.2831853);
    }
}
`;
	}
}

function keywordFor(kind: TemplateKind): string {
	return TEMPLATE_CHOICES.find((choice) => choice.kind === kind)!.keyword;
}

/**
 * Splits `Samples/NS_Spark.dfs` (or an absolute path under a DFX root) into the `Name=` an asset
 * header wants: forward slashes, no extension, no leading slash.
 */
export function assetNameFromRelativePath(relativePath: string): string {
	return relativePath
		.replace(/\\/g, '/')
		.replace(/\.(dfs|dfe|dfm)$/i, '')
		.replace(/^\/+/, '');
}
