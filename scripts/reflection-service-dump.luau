local HttpService = game:GetService("HttpService")
local ReflectionService = game:GetService("ReflectionService")

local REFLECTION_FILTER = {
	Security = SecurityCapabilities.new(unpack(Enum.SecurityCapability:GetEnumItems())),
	ExcludeDisplay = true,
	ExcludeInherited = true,
}

local renames = {
	CoordinateFrame = "CFrame",
	Rect2D = "Rect",
	Vector3Int16 = "Vector3int16",
	Vector2Int16 = "Vector2int16",
	Region3Int16 = "Region3int16",
}

local ok, apiClasses = pcall(ReflectionService.GetClasses, ReflectionService, REFLECTION_FILTER)
if not ok or not apiClasses then
	error("ReflectionService:GetClasses failed: " .. tostring(apiClasses))
end

local classes, classesSize = {}, 1
for _, apiClass in apiClasses do
	local members, membersSize = {}, 1
	local className = apiClass.Name
	local class = {
		Name = className,
		Members = members,
		Superclass = apiClass.Superclass or "<<<ROOT>>>",
		Serialized = apiClass.Serialized == true,
	}
	local permits = apiClass.Permits
	local tags = {}

	if apiClass.Service then
		table.insert(tags, "Service")
	elseif permits and permits["GetService"] then
		table.insert(tags, "Service")
	elseif not permits or not permits["New"] then
		table.insert(tags, "NotCreatable")
	end

	if #tags ~= 0 then
		class.Tags = tags
	end

	local propertiesOk, properties = pcall(
		ReflectionService.GetPropertiesOfClass,
		ReflectionService,
		className,
		REFLECTION_FILTER
	)
	if propertiesOk and properties then
		for _, property in properties do
			local serialized = property.Serialized == true
			local valueType = property.Type
			local valueTypeName = valueType.EngineType
			local category = valueType.Category
			local memberTags = {}

			if not property.Permits or not next(property.Permits) then
				table.insert(memberTags, "NotScriptable")
			end

			if valueTypeName == "Enum" then
				category, valueTypeName = "Enum", valueType.EnumType
			elseif valueTypeName == "RefType" then
				category, valueTypeName = "Class", valueType.InstanceType
			else
				valueTypeName = renames[valueTypeName] or valueTypeName
			end

			local member = {
				Name = property.Name,
				MemberType = "Property",
				ValueType = { Name = valueTypeName, Category = category },
				Serialization = { CanLoad = serialized, CanSave = serialized },
			}

			if #memberTags ~= 0 then
				member.Tags = memberTags
			end

			members[membersSize] = member
			membersSize += 1
		end
	end

	classes[classesSize] = class
	classesSize += 1
end

return HttpService:JSONEncode({ Classes = classes })
