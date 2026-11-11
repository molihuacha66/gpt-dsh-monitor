# Third-party notices

Project-owned code is offered under MIT. Bundled third-party code keeps its own license.

The build collects packages actually included by esbuild, records their names, exact versions and declared licenses in `THIRD-PARTY-NOTICES.json`, and preserves the upstream LICENSE/COPYING/NOTICE files in `third-party-licenses/`. These files are also distributed inside the monitor plugin itself.

Distribution transformation: esbuild combines dependencies into JavaScript bundles and may rewrite module boundaries or minify browser code. Source package files are not distributed verbatim inside those bundles. This notice describes that transformation; it does not replace the upstream license terms or notices. No upstream authors endorse this project.

The current bundle includes MIT, Apache-2.0 and ISC licensed dependencies. In particular, `@modelcontextprotocol/client`, `core` and `server` 2.4.0 declare Apache-2.0, while `@modelcontextprotocol/ext-apps` 2.0.4 declares MIT. Consult the generated manifest for the complete list.
