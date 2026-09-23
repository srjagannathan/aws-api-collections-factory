// SPDX-License-Identifier: Apache-2.0

package com.awspostman.openapi;

import java.util.List;
import software.amazon.smithy.jsonschema.JsonSchemaMapper;
import software.amazon.smithy.model.traits.Trait;
import software.amazon.smithy.openapi.fromsmithy.OpenApiMapper;
import software.amazon.smithy.openapi.fromsmithy.OpenApiProtocol;
import software.amazon.smithy.openapi.fromsmithy.Smithy2OpenApiExtension;
import software.amazon.smithy.openapi.fromsmithy.protocols.AwsRestXmlProtocol;
import software.amazon.smithy.utils.ListUtils;

/**
 * Registers {@code aws.protocols#restXml} OpenAPI conversion support that {@code smithy-openapi}
 * does not ship out of the box: its bundled {@code CoreExtension} only registers OpenApiProtocol
 * providers for restJson1 and rpcv2Json (verified against smithy-openapi 1.72.1's own source; no
 * released version has ever included a restXml converter). Discovered via Java SPI through
 * META-INF/services/software.amazon.smithy.openapi.fromsmithy.Smithy2OpenApiExtension.
 */
public final class RestXmlOpenApiExtension implements Smithy2OpenApiExtension {

    @Override
    public List<OpenApiProtocol<? extends Trait>> getProtocols() {
        return ListUtils.of(new AwsRestXmlProtocol());
    }

    @Override
    public List<JsonSchemaMapper> getJsonSchemaMappers() {
        return ListUtils.of(new RestXmlJsonSchemaMapper());
    }

    @Override
    public List<OpenApiMapper> getOpenApiMappers() {
        return ListUtils.of(new RestXmlRefMetadataMapper());
    }
}
