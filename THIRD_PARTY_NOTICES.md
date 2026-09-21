# Third-Party Notices

AWS API Collections Factory depends on third-party software. Each dependency remains subject to
its own license. The project does not modify or replace those license terms.

## Distributed Browser Dependencies

The production browser artifact includes these direct dependencies and their transitive
dependencies:

| Package | License |
|---|---|
| React and React DOM | MIT |
| Cloudscape Design System components and global styles | Apache-2.0 |

Cloudscape Design System packages include this attribution:

> Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.

## Runtime and Build Dependencies

| Package or project | License |
|---|---|
| openapi-to-postmanv2 | Apache-2.0 |
| Commander | MIT |
| TypeScript | Apache-2.0 |
| Vite | MIT |
| Smithy Java libraries | Apache-2.0 |
| Gson | Apache-2.0 |
| picocli | Apache-2.0 |

Complete dependency versions are recorded in the npm lockfiles and Gradle dependency graph.
Release automation must regenerate and review the software bill of materials and license report
before publishing a binary or hosted artifact.
