// SPDX-License-Identifier: Apache-2.0

// Intentionally in Smithy's own package: AbstractRestProtocol (all the REST path/query/header/
// payload binding logic this class relies on) is package-private there, the same way Smithy's
// own AwsRestJson1Protocol reaches it. See ../../../../../../../../../../com/awspostman/openapi
// (RestXmlOpenApiExtension) for why this class exists at all: smithy-openapi's CoreExtension only
// registers OpenApiProtocol providers for restJson1 and rpcv2Json, never restXml.
package software.amazon.smithy.openapi.fromsmithy.protocols;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.stream.Collectors;
import software.amazon.smithy.aws.traits.protocols.RestXmlTrait;
import software.amazon.smithy.jsonschema.Schema;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.knowledge.HttpBinding;
import software.amazon.smithy.model.node.ArrayNode;
import software.amazon.smithy.model.node.Node;
import software.amazon.smithy.model.node.ObjectNode;
import software.amazon.smithy.model.node.StringNode;
import software.amazon.smithy.model.shapes.CollectionShape;
import software.amazon.smithy.model.shapes.MapShape;
import software.amazon.smithy.model.shapes.MemberShape;
import software.amazon.smithy.model.shapes.Shape;
import software.amazon.smithy.model.shapes.ShapeId;
import software.amazon.smithy.model.shapes.StructureShape;
import software.amazon.smithy.model.traits.TimestampFormatTrait;
import software.amazon.smithy.model.traits.XmlAttributeTrait;
import software.amazon.smithy.model.traits.XmlFlattenedTrait;
import software.amazon.smithy.model.traits.XmlNameTrait;
import software.amazon.smithy.model.traits.XmlNamespaceTrait;
import software.amazon.smithy.openapi.OpenApiConfig;
import software.amazon.smithy.openapi.fromsmithy.Context;

/**
 * Converts the {@code aws.protocols#restXml} protocol to OpenAPI.
 *
 * <p>Mirrors {@code AwsRestJson1Protocol}: all REST HTTP-binding mechanics (path/query/header
 * parameters, response status codes, content negotiation) come from {@link AbstractRestProtocol}.
 * The only protocol-specific work here is producing XML document bodies instead of JSON ones.
 * OpenAPI {@code xml:} schema hints (name/attribute/namespace/wrapped) are attached separately by
 * {@code com.awspostman.openapi.RestXmlJsonSchemaMapper}.
 */
public final class AwsRestXmlProtocol extends AbstractRestProtocol<RestXmlTrait> {

    @Override
    public Class<RestXmlTrait> getProtocolType() {
        return RestXmlTrait.class;
    }

    @Override
    public void updateDefaultSettings(Model model, OpenApiConfig config) {
        // AWS restXml's default document/payload timestamp format is date-time (ISO 8601).
        // Header- and label-bound timestamps are forced separately, elsewhere in AbstractRestProtocol.
        config.setDefaultTimestampFormat(TimestampFormatTrait.Format.DATE_TIME);
    }

    @Override
    String getDocumentMediaType(Context<RestXmlTrait> context, Shape operationOrError, MessageType message) {
        return "application/xml";
    }

    @Override
    Schema createDocumentSchema(
            Context<RestXmlTrait> context,
            Shape operationOrError,
            List<HttpBinding> bindings,
            MessageType message
    ) {
        if (bindings.isEmpty()) {
            return Schema.builder().type("object").build();
        }

        // Same approach as AwsRestJson1Protocol: synthesize a structure containing only the
        // document-bound members (path/query/header members must not leak into the body schema),
        // then hand it to the shared JSON schema converter, whose mappers (including
        // RestXmlJsonSchemaMapper) attach the XML-specific schema keywords.
        ShapeId container = bindings.get(0).getMember().getContainer();
        StructureShape containerShape = context.getModel().expectShape(container, StructureShape.class);

        Set<String> documentMemberNames = bindings.stream()
                .map(HttpBinding::getMemberName)
                .collect(Collectors.toSet());

        StructureShape.Builder containerShapeBuilder = containerShape.toBuilder();
        for (String memberName : containerShape.getAllMembers().keySet()) {
            if (!documentMemberNames.contains(memberName)) {
                containerShapeBuilder.removeMember(memberName);
            }
        }

        StructureShape cleanedShape = containerShapeBuilder.build();
        return context.getJsonSchemaConverter().convertShape(cleanedShape).getRootSchema();
    }

    @Override
    Node transformSmithyValueToProtocolValue(Context<RestXmlTrait> context, Shape shape, Node value) {
        String rootName = shape.asMemberShape()
                .map(member -> elementName(member, member.getMemberName()))
                .orElseGet(() -> elementName(shape, shape.getId().getName()));
        StringBuilder xml = new StringBuilder();
        appendValue(context, shape, rootName, value, xml);
        return Node.from(xml.toString());
    }

    private void appendValue(Context<RestXmlTrait> context, Shape shape, String tagName, Node value, StringBuilder out) {
        if (value == null || value.isNullNode()) {
            return;
        }

        Shape target = shape.asMemberShape()
                .map(member -> context.getModel().expectShape(member.getTarget()))
                .orElse(shape);

        if (target.isStructureShape() || target.isUnionShape()) {
            appendStructured(context, target, tagName, value.expectObjectNode(), out);
        } else if (target instanceof CollectionShape) {
            appendList(context, (CollectionShape) target, tagName, value.expectArrayNode(), out);
        } else if (target.isMapShape()) {
            appendMap(context, target.asMapShape().get(), tagName, value.expectObjectNode(), out);
        } else {
            out.append('<').append(tagName).append('>')
                    .append(escapeXmlText(nodeText(value)))
                    .append("</").append(tagName).append('>');
        }
    }

    private void appendStructured(
            Context<RestXmlTrait> context,
            Shape target,
            String tagName,
            ObjectNode obj,
            StringBuilder out
    ) {
        StringBuilder attributes = new StringBuilder();
        StringBuilder children = new StringBuilder();

        for (Map.Entry<StringNode, Node> entry : obj.getMembers().entrySet()) {
            Optional<MemberShape> memberOpt = target.getMember(entry.getKey().getValue());
            if (!memberOpt.isPresent()) {
                continue;
            }
            MemberShape member = memberOpt.get();
            if (member.hasTrait(XmlAttributeTrait.ID)) {
                attributes.append(' ')
                        .append(elementName(member, member.getMemberName()))
                        .append("=\"")
                        .append(escapeXmlAttribute(nodeText(entry.getValue())))
                        .append('"');
            } else {
                appendValue(context, member, elementName(member, member.getMemberName()), entry.getValue(), children);
            }
        }

        out.append('<').append(tagName).append(namespaceAttribute(target)).append(attributes).append('>')
                .append(children)
                .append("</").append(tagName).append('>');
    }

    private void appendList(Context<RestXmlTrait> context, CollectionShape target, String tagName, ArrayNode array, StringBuilder out) {
        MemberShape itemMember = target.getMember();
        String itemName = elementName(itemMember, "member");
        boolean flattened = target.hasTrait(XmlFlattenedTrait.ID);

        if (flattened) {
            // Flattened: repeated elements use the *containing member's* name, with no wrapper.
            for (Node element : array.getElements()) {
                appendValue(context, itemMember, tagName, element, out);
            }
        } else {
            out.append('<').append(tagName).append('>');
            for (Node element : array.getElements()) {
                appendValue(context, itemMember, itemName, element, out);
            }
            out.append("</").append(tagName).append('>');
        }
    }

    private void appendMap(Context<RestXmlTrait> context, MapShape target, String tagName, ObjectNode obj, StringBuilder out) {
        MemberShape keyMember = target.getKey();
        MemberShape valueMember = target.getValue();
        String keyName = elementName(keyMember, "key");
        String valueName = elementName(valueMember, "value");
        boolean flattened = target.hasTrait(XmlFlattenedTrait.ID);
        // Flattened: each repeated entry uses the *containing member's* name, same as flattened
        // lists. Wrapped (default): entries are always literally "entry", with no outer wrapper
        // beyond that per-entry element (unlike lists, maps have no separate container tag here).
        String entryName = flattened ? tagName : "entry";

        for (Map.Entry<StringNode, Node> entry : obj.getMembers().entrySet()) {
            out.append('<').append(entryName).append('>')
                    .append('<').append(keyName).append('>')
                    .append(escapeXmlText(entry.getKey().getValue()))
                    .append("</").append(keyName).append('>');
            appendValue(context, valueMember, valueName, entry.getValue(), out);
            out.append("</").append(entryName).append('>');
        }
    }

    private String elementName(Shape shape, String fallback) {
        return shape.getTrait(XmlNameTrait.class).map(XmlNameTrait::getValue).orElse(fallback);
    }

    private String namespaceAttribute(Shape shape) {
        return shape.getTrait(XmlNamespaceTrait.class)
                .map(ns -> " xmlns" + ns.getPrefix().map(prefix -> ":" + prefix).orElse("") + "=\"" + ns.getUri() + "\"")
                .orElse("");
    }

    private String nodeText(Node value) {
        return value.isStringNode() ? value.expectStringNode().getValue() : Node.printJson(value);
    }

    private String escapeXmlText(String text) {
        return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
    }

    private String escapeXmlAttribute(String text) {
        return escapeXmlText(text).replace("\"", "&quot;");
    }
}
