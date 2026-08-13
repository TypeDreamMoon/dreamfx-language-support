// A Body whose braces would close the block early if it were tokenised rather than read raw.
Module(Name="Modules/M_Fixture", Root="Plugin.DreamFX")
{
    Settings = {
        Usage       = ParticleUpdate;
        Category    = "DreamFX|Test";
        Description = "Braces, a string containing \"}\", and a commented-out } .";
    }

    Inputs = {
        float SpinRate   = 90.0  [ Description="Degrees per second." ];
        bool  bClockwise = true  [ StaticSwitch ];
        float RateScale  = 1.0   [ Advanced ];
    }

    Body = {
        float Dir = bClockwise ? 1.0 : -1.0;
        if (RateScale > 0.0)
        {
            // }
            Particles.SpriteRotation += SpinRate * RateScale * Dir * Engine.DeltaTime;
        }
    }
}
