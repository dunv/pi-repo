# Source-only Home Manager fragment. Caller supplies a VERIFIED immutable source.
# This deliberately does not fetch/pin unpublished sources, install Pueue, or enable services.
{ src }:
{
  home.file.".pi/agent/extensions/pi-repo".source = src;
}
