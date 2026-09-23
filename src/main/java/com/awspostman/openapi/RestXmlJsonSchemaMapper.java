// SPDX-License-Identifier: Apache-2.0

package com.awspostman.openapi;

import java.util.Optional;
import software.amazon.smithy.aws.traits.protocols.RestXmlTrait;
import software.amazon.smithy.jsonschema.JsonSchemaMapper;
import software.amazon.smithy.jsonschema.JsonSchemaMapperContext;
import software.amazon.smithy.jsonschema.Schema;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.node.Node;
import software.amazon.smithy.model.node.ObjectNode;
import software.amazon.smithy.model.shapes.CollectionShape;
import software.amazon.smithy.model.shapes.Shape;
import software.amazon.smithy.model.traits.XmlAttributeTrait;
import software.amazon.smithy.model.traits.XmlFlattenedTrait;
import software.amazon.smithy.model.traits.XmlNameTrait;
import software.amazon.smithy.model.traits.XmlNamespaceTrait;

/**
 * Adds OpenAPI {@code xml:} schema hints (name, attribute, namespace, wrapped) derived from
 * Smithy's {@code xmlName}/{@code xmlAttribute}/{@code xmlNamespace}/{@code xmlFlattened} traits.
 *
 * <p>Smithy's {@code JsonSchemaMapper} SPI has no protocol scoping: every registered mapper runs
 * for every shape conversion regardless of which protocol is active, so this self-gates on the
 * model actually using {@code aws.protocols#restXml}. Without that check, restJson1/awsJson/etc.
 * schemas would pick up meaningless {@code xml:} metadata too.
 */
public final class RestXmlJsonSchemaMapper implements JsonSchemaMapper {

    @Override
    public Schema.Builder updateSchema(JsonSchemaMapperContext context, Schema.Builder builder) {
        if (!context.getModel().isTraitApplied(RestXmlTrait.class)) {
            return builder;
        }

        Optional<ObjectNode> xml = buildXmlExtension(context.getShape(), context.getModel());
        return xml.isPresent() ? builder.putExtension("xml", xml.get()) : builder;
    }

    /**
     * Builds the OpenAPI {@code xml} object for a shape (or {@code Optional.empty()} if none of
     * the relevant traits are present), so both this mapper and
     * {@code AwsRestXmlProtocol}'s bare-$ref post-processing (see its class doc) can share the
     * exact same trait-to-hint logic.
     */
    static Optional<ObjectNode> buildXmlExtension(Shape shape, Model model) {
        ObjectNode.Builder xml = Node.objectNodeBuilder();
        boolean changed = false;

        if (shape.hasTrait(XmlAttributeTrait.ID)) {
            xml.withMember("attribute", true);
            changed = true;
        }

        Optional<XmlNameTrait> xmlName = shape.getTrait(XmlNameTrait.class);
        if (xmlName.isPresent()) {
            xml.withMember("name", xmlName.get().getValue());
            changed = true;
        }

        Optional<XmlNamespaceTrait> xmlNamespace = shape.getTrait(XmlNamespaceTrait.class);
        if (xmlNamespace.isPresent()) {
            xml.withMember("namespace", xmlNamespace.get().getUri());
            if (xmlNamespace.get().getPrefix().isPresent()) {
                xml.withMember("prefix", xmlNamespace.get().getPrefix().get());
            }
            changed = true;
        }

        Shape target = shape.asMemberShape()
                .map(member -> model.expectShape(member.getTarget()))
                .orElse(shape);
        if (target instanceof CollectionShape || target.isMapShape()) {
            // Smithy's restXml wire format wraps list/set/map entries in a containing element by
            // default; @xmlFlattened removes the wrapper. OpenAPI's own array default ("wrapped"
            // absent, meaning false) is the opposite, so it must be stated explicitly here rather
            // than left to inherit OpenAPI's default.
            boolean flattened = shape.hasTrait(XmlFlattenedTrait.ID) || target.hasTrait(XmlFlattenedTrait.ID);
            xml.withMember("wrapped", !flattened);
            changed = true;
        }

        return changed ? Optional.of(xml.build()) : Optional.empty();
    }
}
