//#region src/host/index.ts
const name = "@pananfly/dsh-lan-access";
const inject = [];
function apply(ctx) {
	ctx.logger?.info?.(`dsh-lan-access: anchor loaded (LAN access mode, BrowserAuth token auth)`);
	ctx.effect(() => () => {}, "dsh-lan-access anchor");
}
//#endregion
export { apply, inject, name };
