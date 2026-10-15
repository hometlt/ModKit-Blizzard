import { CEnum } from "./schema.core.js"

enum E_LocaleId { }
enum E_ClassIdCAbil { CAbil, CAbilProgress, CAbilEffect, CAbilQueueable, CAbilRedirect, CAbilArmMagazine, CAbilAttack, CAbilAugment, CAbilAttackModifier, CAbilBattery, CAbilBeacon, CAbilBehavior, CAbilBuild, CAbilBuildable, CAbilEffectInstant, CAbilEffectTarget, CAbilHarvest, CAbilInteract, CAbilInventory, CAbilLearn, CAbilMerge, CAbilMergeable, CAbilMorph, CAbilMorphPlacement, CAbilMove, CAbilPawn, CAbilQueue, CAbilRally, CAbilRedirectInstant, CAbilRedirectTarget, CAbilResearch, CAbilRevive, CAbilSpecialize, CAbilStop, CAbilTrain, CAbilTransport, CAbilWarpable, CAbilWarpTrain }
enum E_ClassIdCAccumulator { CAccumulator, CAccumulatorConstant, CAccumulatorVitals, CAccumulatorDistance, CAccumulatorBehavior, CAccumulatorAttributePoints, CAccumulatorTrackedUnitCount, CAccumulatorLevel, CAccumulatorAbilLevel, CAccumulatorUnitLevel, CAccumulatorVeterancyLevel, CAccumulatorCargo, CAccumulatorEffectAmount, CAccumulatorUserData, CAccumulatorUnitCustomValue, CAccumulatorSwitch, CAccumulatorArithmetic, CAccumulatorPlayerScoreValue }
enum E_ClassIdCAchievement { CAchievement }
enum E_ClassIdCAchievementTerm { CAchievementTerm, CAchievementTermAbil, CAchievementTermAbilInteract, CAchievementTermAbilLoad, CAchievementTermAbilUse, CAchievementTermAchievement, CAchievementTermBehavior, CAchievementTermBehaviorAbsorbed, CAchievementTermBehaviorCount, CAchievementTermBehaviorElapsed, CAchievementTermBehaviorState, CAchievementTermCombine, CAchievementTermEffect, CAchievementTermEffectAbsorbed, CAchievementTermEffectDamaged, CAchievementTermEffectDodged, CAchievementTermEffectHealed, CAchievementTermEffectKilled, CAchievementTermEffectUse, CAchievementTermGeneric, CAchievementTermReplay, CAchievementTermScoreValue, CAchievementTermTime, CAchievementTermUnit, CAchievementTermUnitBirth, CAchievementTermUnitDeath, CAchievementTermUnitKills, CAchievementTermUnitRegen, CAchievementTermUnitSupplyLoss }
enum E_ClassIdCActor { CActor, CActorSupport, CActorBase, CActorBearings, CActorCamera, CActorModel, CActorModelMaterial, CActorQuad, CActorForce, CActorForceLineSegment, CActorBeam, CActorRange, CActorSound, CActorSplat, CActorAction, CActorActionOverride, CActorArc, CActorBeamSimple, CActorBeamStandard, CActorBlob, CActorCameraModel, CActorCreep, CActorCutscene, CActorDoodad, CActorDoodadPreserver, CActorFoliageFXSpawner, CActorEditorCamera, CActorEditorPoint, CActorEventMacro, CActorEventMacroRunnable, CActorForceBox, CActorForceConeRoundedEnd, CActorForceCylinder, CActorForceSphere, CActorGlobalConfig, CActorOverrides, CActorLight, CActorLightOmni, CActorLightSpot, CActorLightModel, CActorLightOmniModel, CActorLightSpotModel, CActorLookAt, CActorList, CActorListPerPlayer, CActorPortrait, CActorPower, CActorProgress, CActorPropertyCurveSet, CActorQueryResponse, CActorRegion, CActorRegionArc, CActorRegionCircle, CActorRegionCombine, CActorRegionGame, CActorRegionPolygon, CActorRegionQuad, CActorRegionWater, CActorScene, CActorSelection, CActorSetQueried, CActorShadow, CActorShield, CActorShieldImpact, CActorSimple, CActorSite, CActorSiteBillboard, CActorSiteMover, CActorSiteOrbiter, CActorSiteRocker, CActorSiteOp, CActorSiteOpBase, CActorSiteOp2DRotation, CActorSiteOpAction, CActorSiteOpAttach, CActorSiteOpAttachVolume, CActorSiteOpBanker, CActorSiteOpBankerUnit, CActorSiteOpBasic, CActorSiteOpGameCameraFollow, CActorSiteOpDeathMotion, CActorSiteOpDeltaSum, CActorSiteOpEffect, CActorSiteOpForward, CActorSiteOpHeight, CActorSiteOpHigherOfTerrainAndWater, CActorSiteOpHostBearings, CActorSiteOpHostedOffset, CActorSiteOpIncoming, CActorSiteOpLocalOffset, CActorSiteOpOrientAttachPointTo, CActorSiteOpPatch, CActorSiteOpPersistentOffset, CActorSiteOpOrbiter, CActorSiteOpPhysicsImpact, CActorSiteOpRandomPointInCircle, CActorSiteOpRandomPointInCrossbar, CActorSiteOpRandomPointInSphere, CActorSiteOpRotationExplicit, CActorSiteOpRotationRandom, CActorSiteOpRotationVariancer, CActorSiteOpRotator, CActorSiteOpRotationSmooth, CActorSiteOpSelectionOffset, CActorSiteOpSerpentHead, CActorSiteOpSerpentSegment, CActorSiteOpShadow, CActorSiteOpTether, CActorSiteOpTipability, CActorSiteOpTilter, CActorSiteOpUp, CActorSiteOpZ, CActorSiteOpCursor, CActorSiteOpYawLimiter, CActorSiteOpPitchLimiter, CActorSnapshot, CActorStateMonitor, CActorSquib, CActorBatch, CActorTerrain, CActorTerrainDeformer, CActorText, CActorTurret, CActorUnit, CActorUnitRing, CActorMissile, CActorMinimap, }
enum E_ClassIdCAlert { CAlert }
enum E_ClassIdCArmyCategory { CArmyCategory }
enum E_ClassIdCArmyUnit { CArmyUnit }
enum E_ClassIdCArmyUpgrade { CArmyUpgrade }
enum E_ClassIdCArtifact { CArtifact }
enum E_ClassIdCArtifactSlot { CArtifactSlot }
enum E_ClassIdCAttachMethod { CAttachMethod, CAttachMethodArcTest, CAttachMethodBestMatch, CAttachMethodFilter, CAttachMethodAttachType, CAttachMethodIncoming, CAttachMethodLeastDeflection, CAttachMethodNodeOccupancy, CAttachMethodNodeOccupancy2, CAttachMethodNumericField, CAttachMethodPattern, CAttachMethodPortAllocator, CAttachMethodProximity, CAttachMethodRandom, CAttachMethodReduction, CAttachMethodVolumesRequery, CAttachMethodVolumesTargets, CAttachMethodVolumesWeightedPick }
enum E_ClassIdCBankCondition { CBankCondition, CBankConditionCompare, CBankConditionCompareValueCount, CBankConditionCompareValueInteger, CBankConditionCompareValueString, CBankConditionCompareValueSum, CBankConditionCombine, CBankConditionCurrentMap }
enum E_ClassIdCBeam { CBeam, CBeamSync, CBeamSyncSweeper, CBeamAsync, CBeamAsyncLinear, CBeamAsyncShadow }
enum E_ClassIdCBehavior { CBehavior, CBehaviorAttackModifier, CBehaviorAttribute, CBehaviorUnitTracker, CBehaviorBuff, CBehaviorClickResponse, CBehaviorConjoined, CBehaviorCreepSource, CBehaviorJump, CBehaviorPowerSource, CBehaviorPowerUser, CBehaviorResource, CBehaviorReveal, CBehaviorSpawn, CBehaviorVeterancy, CBehaviorWander }
enum E_ClassIdCBoost { CBoost }
enum E_ClassIdCBundle { CBundle }
enum E_ClassIdCButton { CButton }
enum E_ClassIdCCamera { CCamera }
enum E_ClassIdCCampaign { CCampaign }
enum E_ClassIdCCharacter { CCharacter }
enum E_ClassIdCCliff { CCliff }
enum E_ClassIdCCliffMesh { CCliffMesh }
enum E_ClassIdCColorStyle { CColorStyle }
enum E_ClassIdCCommander { CCommander }
enum E_ClassIdCConfig { CConfig }
enum E_ClassIdCConsoleSkin { CConsoleSkin }
enum E_ClassIdCConversation { CConversation }
enum E_ClassIdCConversationState { CConversationState }
enum E_ClassIdCCursor { CCursor }
enum E_ClassIdCDataCollection { CDataCollection, CDataCollectionUnit, CDataCollectionUpgrade, CDataCollectionAbil }
enum E_ClassIdCDataCollectionPattern { CDataCollectionPattern }
enum E_ClassIdCDecalPack { CDecalPack }
enum E_ClassIdCDSP { CDSP, CDSPChorus, CDSPCompressor, CDSPCustomCompressor, CDSPDistortion, CDSPEcho, CDSPFlange, CDSPHighPass, CDSPLimiter, CDSPLowPass, CDSPLowPassSimple, CDSPNormalize, CDSPOscillator, CDSPParamEQ, CDSPPitchShift, CDSPReverb }
enum E_ClassIdCEffect { CEffect, CEffectResponse, CEffectAddTrackedUnit, CEffectClearTrackedUnits, CEffectAddTrackedUnits, CEffectRemoveTrackedUnit, CEffectApplyBehavior, CEffectApplyForce, CEffectApplyKinetic, CEffectCancelOrder, CEffectCreateHealer, CEffectCreep, CEffectCreatePersistent, CEffectRandomPointInCircle, CEffectCreateUnit, CEffectDamage, CEffectDestroyHealer, CEffectDestroyPersistent, CEffectEnumArea, CEffectEnumTrackedUnits, CEffectEnumMagazine, CEffectEnumTransport, CEffectEnumInventory, CEffectLastTarget, CEffectLoadContainer, CEffectIssueOrder, CEffectLaunchMissile, CEffectModifyPlayer, CEffectModifyUnit, CEffectMorph, CEffectRedirectMissile, CEffectReleaseMagazine, CEffectRemoveBehavior, CEffectRemoveKinetic, CEffectReturnMagazine, CEffectSet, CEffectSwitch, CEffectTeleport, CEffectTransferBehavior, CEffectUseCalldown, CEffectUseMagazine, CEffectUserData }
enum E_ClassIdCEmoticon { CEmoticon }
enum E_ClassIdCEmoticonPack { CEmoticonPack }
enum E_ClassIdCFootprint { CFootprint }
enum E_ClassIdCFoW { CFoW }
enum E_ClassIdCGame { CGame }
enum E_ClassIdCGameUI { CGameUI }
enum E_ClassIdCHerd { CHerd }
enum E_ClassIdCHerdNode { CHerdNode }
enum E_ClassIdCHero { CHero }
enum E_ClassIdCHeroAbil { CHeroAbil }
enum E_ClassIdCHeroStat { CHeroStat }
enum E_ClassIdCItem { CItem, CItemAbil, CItemAbilPowerUp, CItemEffect, CItemEffectInstant, CItemEffectTarget, }
enum E_ClassIdCItemClass { CItemClass }
enum E_ClassIdCItemContainer { CItemContainer }
enum E_ClassIdCKinetic { CKinetic, CKineticFollow, CKineticRotate, CKineticSequence, CKineticSet, CKineticTranslate, CKineticDistance }
enum E_ClassIdCLensFlareSet { CLensFlareSet }
enum E_ClassIdCLight { CLight }
enum E_ClassIdCLocation { CLocation }
enum E_ClassIdCLoot { CLoot, CLootSpawn, CLootEffect, CLootItem, CLootSet, CLootUnit }
enum E_ClassIdCMap { CMap }
enum E_ClassIdCModel { CModel, CModelFoliage }
enum E_ClassIdCMount { CMount }
enum E_ClassIdCMover { CMover, CMoverAvoid, CMoverFlock, CMoverMissile, CMoverNull, }
enum E_ClassIdCObjective { CObjective }
enum E_ClassIdCPhysicsMaterial { CPhysicsMaterial }
enum E_ClassIdCPing { CPing }
enum E_ClassIdCPlayerResponse { CPlayerResponse, CPlayerResponseUnit, CPlayerResponseUnitDamage, CPlayerResponseUnitDeath, CPlayerResponseUnitBirth }
enum E_ClassIdCPortraitPack { CPortraitPack }
enum E_ClassIdCPreload { CPreload, CPreloadAsset, CPreloadScene, CPreloadActor, CPreloadConversation, CPreloadModel, CPreloadSound, CPreloadUnit }
enum E_ClassIdCPremiumMap { CPremiumMap }
enum E_ClassIdCRace { CRace }
enum E_ClassIdCRaceBannerPack { CRaceBannerPack }
enum E_ClassIdCRequirement { CRequirement }
enum E_ClassIdCRequirementNode { CRequirementNode, CRequirementGT, CRequirementLT, CRequirementGTE, CRequirementLTE, CRequirementEq, CRequirementNE, CRequirementAnd, CRequirementOr, CRequirementXor, CRequirementNot, CRequirementOdd, CRequirementDiv, CRequirementMod, CRequirementMul, CRequirementSum, CRequirementConst, CRequirementAllowAbil, CRequirementAllowBehavior, CRequirementAllowUnit, CRequirementAllowUpgrade, CRequirementCountAbil, CRequirementCountBehavior, CRequirementCountEffect, CRequirementCountUnit, CRequirementCountUpgrade }
enum E_ClassIdCReverb { CReverb }
enum E_ClassIdCReward { CReward, CRewardDecal, CRewardIcon, CRewardModel, CRewardPortrait, CRewardBadge, CRewardPoints, CRewardTrophy, CRewardEmoticon, CRewardVoicePack, CRewardPortraitInGame, CRewardConsoleSkin, CRewardSpray, CRewardSprayUseDecal, CRewardRaceBanner, CRewardStim }
enum E_ClassIdCScoreResult { CScoreResult, CScoreResultRoot, CScoreResultScore, CScoreResultGraph, CScoreResultPane, CScoreResultBuildOrder, CScoreResultCallouts, CScoreResultExperience, CScoreResultPerformance }
enum E_ClassIdCScoreValue { CScoreValue, CScoreValueCustom, CScoreValueStandard, CScoreValueConstant, CScoreValueCombine }
enum E_ClassIdCShape { CShape, CShapeArc, CShapeQuad }
enum E_ClassIdCSkin { CSkin }
enum E_ClassIdCSkinPack { CSkinPack }
enum E_ClassIdCSound { CSound }
enum E_ClassIdCSoundExclusivity { CSoundExclusivity }
enum E_ClassIdCSoundMixSnapshot { CSoundMixSnapshot }
enum E_ClassIdCSoundtrack { CSoundtrack }
enum E_ClassIdCSpray { CSpray }
enum E_ClassIdCSprayPack { CSprayPack }
enum E_ClassIdCStimPack { CStimPack }
enum E_ClassIdCTacCooldown { CTacCooldown }
enum E_ClassIdCTactical { CTactical, CTacticalOrder, CTacticalSet }
enum E_ClassIdCTalent { CTalent }
enum E_ClassIdCTalentProfile { CTalentProfile }
enum E_ClassIdCTargetFind { CTargetFind, CTargetFindBestPoint, CTargetFindWorkerRallyPoint, CTargetFindRallyPoint, CTargetFindEnumArea, CTargetFindEffect, CTargetFindLastAttacker, CTargetFindOffset, CTargetFindOrder, CTargetFindSet }
enum E_ClassIdCTargetSort { CTargetSort, CTargetSortAlliance, CTargetSortAngle, CTargetSortBehaviorCount, CTargetSortBehaviorDuration, CTargetSortChargeCount, CTargetSortChargeRegen, CTargetSortCooldown, CTargetSortDistance, CTargetSortField, CTargetSortInterruptible, CTargetSortMarker, CTargetSortPowerSourceLevel, CTargetSortPowerUserLevel, CTargetSortPriority, CTargetSortRandom, CTargetSortValidator, CTargetSortVeterancy, CTargetSortVital, CTargetSortVitalFraction }
enum E_ClassIdCTerrain { CTerrain }
enum E_ClassIdCTerrainObject { CTerrainObject }
enum E_ClassIdCCliffDoodad { CCliffDoodad }
enum E_ClassIdCTerrainTex { CTerrainTex }
enum E_ClassIdCTexture { CTexture }
enum E_ClassIdCTextureSheet { CTextureSheet }
enum E_ClassIdCTile { CTile }
enum E_ClassIdCTrophy { CTrophy }
enum E_ClassIdCTurret { CTurret }
enum E_ClassIdCUnit { CUnit, CUnitHero }
enum E_ClassIdCUpgrade { CUpgrade }
enum E_ClassIdCUser { CUser }
enum E_ClassIdCValidator { CValidator, CValidatorCombine, CValidatorCondition, CValidatorFunction, CValidatorEffect, CValidatorEffectCompare, CValidatorEffectCompareDodged, CValidatorEffectCompareEvaded, CValidatorEffectTreeUserData, CValidatorGameCompareTimeEvent, CValidatorGameCompareTimeOfDay, CValidatorGameCompareTerrain, CValidatorGameCommanderActive, CValidatorLocation, CValidatorLocationCompareCliffLevel, CValidatorLocationComparePower, CValidatorLocationCompareRange, CValidatorLocationArc, CValidatorLocationCreep, CValidatorLocationCrossChasm, CValidatorLocationCrossCliff, CValidatorLocationEnumArea, CValidatorLocationPathable, CValidatorLocationInPlayableMapArea, CValidatorLocationPlacement, CValidatorLocationShrub, CValidatorLocationType, CValidatorLocationVision, CValidatorPlayer, CValidatorPlayerAlliance, CValidatorPlayerRequirement, CValidatorPlayerTalent, CValidatorPlayerFood, CValidatorPlayerCompare, CValidatorPlayerCompareDifficulty, CValidatorPlayerCompareFoodAvailable, CValidatorPlayerCompareFoodMade, CValidatorPlayerCompareFoodUsed, CValidatorPlayerCompareRace, CValidatorPlayerCompareResource, CValidatorPlayerCompareResult, CValidatorPlayerCompareType, CValidatorUnit, CValidatorUnitInWeaponRange, CValidatorUnitAI, CValidatorUnitCombatAI, CValidatorUnitAlliance, CValidatorUnitAbil, CValidatorUnitBehaviorStackAlias, CValidatorUnitBehaviorState, CValidatorUnitState, CValidatorUnitDetected, CValidatorUnitArmor, CValidatorUnitFilters, CValidatorUnitFlying, CValidatorUnitInventory, CValidatorUnitInventoryIsFull, CValidatorUnitInventoryContainsItem, CValidatorUnitLastDamagePlayer, CValidatorUnitKinetic, CValidatorUnitMissileNullified, CValidatorUnitMover, CValidatorUnitOrder, CValidatorUnitOrderQueue, CValidatorUnitOrderTargetPathable, CValidatorUnitOrderTargetType, CValidatorUnitPathable, CValidatorUnitPathing, CValidatorUnitScanning, CValidatorUnitType, CValidatorUnitWeaponAnimating, CValidatorUnitWeaponFiring, CValidatorUnitWeaponPlane, CValidatorUnitTestWeaponType, CValidatorUnitCompare, CValidatorUnitCompareAIAreaEvalRatio, CValidatorUnitCompareAbilLevel, CValidatorUnitCompareAbilSkillPoint, CValidatorUnitCompareAbilStage, CValidatorUnitCompareAttackPriority, CValidatorUnitCompareBehaviorCount, CValidatorUnitCompareCargo, CValidatorUnitCompareChargeUsed, CValidatorUnitCompareCooldown, CValidatorUnitCompareDamageDealtTime, CValidatorUnitCompareDamageTakenTime, CValidatorUnitCompareDeath, CValidatorUnitCompareDetectRange, CValidatorUnitCompareField, CValidatorUnitCompareKillCount, CValidatorUnitCompareMarkerCount, CValidatorUnitCompareMoverPhase, CValidatorUnitCompareOrderCount, CValidatorUnitCompareOrderTargetRange, CValidatorUnitComparePowerSourceLevel, CValidatorUnitComparePowerUserLevel, CValidatorUnitCompareRallyPointCount, CValidatorUnitCompareResourceContents, CValidatorUnitCompareResourceHarvesters, CValidatorUnitCompareSpeed, CValidatorUnitCompareVeterancyLevel, CValidatorUnitCompareVital, CValidatorUnitCompareVitality, CValidatorUnitCompareHeight, CValidatorCompareTrackedUnitsCount, CValidatorIsUnitTracked }
enum E_ClassIdCVoiceOver { CVoiceOver }
enum E_ClassIdCVoicePack { CVoicePack }
enum E_ClassIdCWarChest { CWarChest }
enum E_ClassIdCWarChestSeason { CWarChestSeason }
enum E_ClassIdCWater { CWater }
enum E_ClassIdCWeapon { CWeapon, CWeaponLegacy, CWeaponStrafe }

enum E_PlayerTeam { DefaultNeutral = 16, Owner, Ally, Enemy, TeamHostile, TeamOrder, TeamChaos }
enum E_ColorEntry { DefaultNeutral, Owner, Ally, Enemy, TeamHostile, TeamOrder, TeamChaos }
enum E_AbilCmdState { Restricted, Suppressed, Available }
enum E_CooldownLocation { Player, Unit, Behavior, Global, Abil }
enum E_AbilAlignment { Negative, Positive, Neutral }
enum E_ChargeLocation { Unit, Abil, Player, Behavior, Global }
enum E_AbilTechPlayer { Upkeep, Owner, CasterPlayer }
enum E_FogVisibility { Dimmed, Visible, Snapshot, Hidden }
enum E_AttachKeyword { TurretY, Forearm, Overhead, SetC, Air, Weapon, Target, SetB, Foot, Right, Left, Waist, Back, Shoulder, Hand, Center, SetA, Origin, Hardpoint, Damage, Chest, Mount, Head, Top, TurretZ, StatusBar, CustomA, Heavy, Light, Medium, Shield, Bottom, Ground, Upgrade, Armor, Engine, Agria, Aiur, Albion, Alternate, Attacher, Avernus, BelShir, Cargo, Castanar, Channel, Char, Chin, CustomB, CustomC, Death, Dylar, Effector, Face, Final, Front, Haven, Hit, HPBar, IGNORE, Knee, Korhal, Lip, MacGuffin, MarSara, Meinhoff, Monlyth, Moria, Movement, NewFolsom, PortZion, Primary, PU72516J, RallyPoint, Rear, Redstone, Secondary, TargetShield, Tarsonis, Transmission, Turret, Tyrador, Umoja, Upper, Valhalla, Work, Xil, EatTree }
enum E_ActorScopeBearingsTrackingType { ForceOff, AutomaticBySituation, ForceOn }
enum E_ActorRequestScope { Caster, Target, TargetOuter, Source, Effect, Outer, Missile, Implicit, CasterOuter }
enum E_ActorRequestActor { Find, Create, Implicit }
enum E_ActorEffectScope { Caster, Effect, CasterOuter, Missile, Outer, OuterContainer, Source, SourceInside, SourceOutside, Target, TargetOuter }
enum E_ActorShieldFlashType { Header, None, Full, Facer }
enum E_SplatLayer { PowerLayer, AOELayer, VectorUILayer, MaterialUILayer, BlobShadowLayer, BuildingLayer, FakeVectorUILayer, Layer0, Layer1, Layer2, Layer3 }
enum E_CmdResult { CantSeeBuildLocation, CantSeeLandLocation, CantBuildLocationInvalid, CantLandLocationInvalid, CouldntReachTarget, CantFindPlacementLocation, CantBuildOnThat, MustTargetUnit, CantBuildTooFarFromCreepSource, CantLandTooFarFromCreepSource, CantLandTooFarFromBuildPowerSource, CantBuildTooFarFromBuildPowerSource, TargetIsOutOfRange }
enum E_ActorOverkillTestType { PercentageOfMaxLifePlusShields, Fixed, PercentageOfMaxLife }
enum E_ActorSplatHeight { MinimumTerrain, Automatic, MinimumActor, Normal }
enum E_AMFilterLogic { OR, XOR, FullMatch, AND, NAND }
enum E_EffectTimeScale { Caster, Global, Target }
enum E_BehaviorAlignment { Positive, Negative, Neutral }
enum E_EffectLocationType { Point, UnitOrPoint, Unit }
enum E_DamageVisibility { Visible, Hidden, Snapshot }
enum E_EffectModifyFacing { LookAt, Copy }
enum E_Occlusion { Show, None, Hide }
enum E_ModelEvent { Custom, Sound, Actor, FootprintLeft, FootprintRight }
enum E_SquibType { Metal, None, Flesh, Shield, Rock, LightArmor, Miss, Dirt, Sand, Snow, Water, Wood }
enum E_MotionDriverType { Throw, Guidance, Ballistic, AdaptableParabola, None }
enum E_MotionOverlayType { Revolver, Wave, Orbit, None }
enum E_MotionOverlayPolarity { Random, Alternating, Negative, None, Positive }
enum E_MotionThrowRotationType { ThrowForward, LookAtTarget, Vectored, LookAtTarget2D, LauncherForward, None }
enum E_MotionArrivalTestType { '2D', '3D', Never, Adaptive }
enum E_MotionBlendType { Linear, Logarithmic, Exponential, None }
enum E_MotionTurnType { Optimal, RevertToUp, Default }
enum E_MotionRotationActorType { LookAtTarget, LookAtTarget2D, Upright, Docking, None, ZeroRoll }
enum E_SoundDupe { Replace, Prevent }
enum E_SoundMode { '2D', '3DWorld', '3DHead' }
enum E_SoundDupePriority { Oldest, Default }
enum E_SoundSelect { Sequential, Random, Shuffle }
enum E_TurretIdle { ResetIfMoving, Hold, Reset, Spin, FollowMovement, FollowMovementReverse }
enum E_UnitMob { Campaign, Multiplayer, None, Classic, OnHold, Story, Obsolete, Warcraft }
enum E_CostCategory { Army, Economy, Technology, None, Upgrade }
enum E_CardButtonType { AbilCmd, Passive, Submenu, CancelSubmenu, SelectBuilder, Undefined, SelectLarva, CancelPlacementMode, CancelTargetMode }
enum E_AcquireLevel { Defensive, None, Offensive, Passive }
enum E_UnitResponse { Flee, Nothing, AcquireNoFlee, Acquire }
enum E_UnitDisplay { Always, Never, Default }
enum E_Display { Minerals, Terrazine, Vespene, Custom }
enum E_ValidateCombine { And, Or }
enum E_UnitType { TechAlias, SelectAlias, AIBully, LeaderAlias, Link }
enum E_WeaponLegacyMovement { Slowing, Moving, None }
enum E_WeaponPrioritization { ByAngle, ByDistanceFromTarget, ByDistance }
enum E_AbilArmMagazineManage { Recall, Destroy, Ignore }
enum E_AbilOrderDisplayType { Confirm, Attack, Rally, Move, Legacy }
enum E_VitalsAccumulatorModificationType { PerUnitMaxVital, PerUnit, Relative }
enum E_ActorHostedPropInheritType { OneShot, Continuous, None }
enum E_UnitSound { Ready, Help, Attack, Birth, Board, Click, ClickError, Construction, Highlight, Movement, Pissed, Turning, What, Yes }
enum E_AlertPeripheral { AllyBaseUnderAttack, SelfBaseUnderAttack, AllyUnitUnderAttack, SelfUnitUnderAttack, BuildingComplete, CalldownLaunch, MorphComplete, MothershipComplete, ResearchComplete, ResourceExhausted, SpecializationComplete, TrainComplete, UpgradeComplete, WarpInComplete, ResourceDepleted, SelfUnitDied, SelfUnitRevived, LarvaHatched, MULEExpired, ChronoBoostExpired, EnemyBuildingKilled, EnemyUnitKilled, MothershipStart, SelfTownPortalUsed, SelfUltimateUsed, SelfUnitStunned, TeamBossLost, TeamBossTaken, TeamLeaderUnderAttack, TeamMercCampLost, TeamMercCampTaken, TrainingComplete }
enum E_BehaviorUnitTrackerAtMaxRule { ReplaceOldest, Ignore }
enum E_ListWalkMode { RandomNoRepeat, Shuffle, Random }
enum E_PathMode { Flying, Jumper, Scaler, Builder, Digger, Ground, Amphibious, Float }
enum E_MotionActorTrackingType { Linear, Actual, Hookless }
enum E_MotionRotationLaunchActorType { LaunchToTarget, LaunchToTarget2D, Supplied, None }
enum E_TargetFindSet { Sequential, Successful, Combined }
enum E_ResourceState { Harvestable, Raw }
enum E_ScoreValue { APM, APMAverage, CPM, MutatorTryAgain1, MutatorTryAgain2, MutatorTryAgain3, MutatorTryAgain4, ACEnemyRace, ACEnemyWaveType, UncontestedCombatTime, IdleProductionTime, IdleWorkerTime, UnitKillsPeakCount, UnitsTotalCount, UnitsKilledCount, UnitsLostCount, UnitsFriendlyFireCount, UnitsSalvagedCount, UnitsCanceledCount, UnitsPeakCount, UnitsInProgressCount, UnitsActiveCount, UnitsStartCount, UnitsTotalValue, UnitsKilledValue, UnitsLostValue, UnitsPeakValue, UnitsMadePoints, UnitsKilledPoints, StructuresTotalCount, StructuresKilledCount, StructuresLostCount, StructuresFriendlyFireCount, StructuresSalvagedCount, StructuresCanceledCount, StructuresPeakCount, StructuresActiveCount, StructuresStartCount, StructuresTotalValue, StructuresKilledValue, StructuresLostValue, StructuresPeakValue, StructuresMadePoints, StructuresKilledPoints, WorkersActiveCount, WorkersTotalCount, WorkersLostCount, PreventDefeatQueuedCount, PreventDefeatInProgressCount, PreventDefeatActiveCount, PreventDestroyQueuedCount, PreventDestroyInProgressCount, PreventDestroyActiveCount, PreventRevealQueuedCount, PreventRevealInProgressCount, PreventRevealActiveCount, WeaponTechnologyCount, ArmorTechnologyCount, MiscTechnologyCount, WeaponTechnologyValue, ArmorTechnologyValue, MiscTechnologyValue, TechnologyPercent, TechnologyPoints, FoodCappedTime, FoodMade, FoodMadeKilled, FoodMadeLost, FoodUsed, FoodUsedKilled, FoodUsedLost, FoodUsedNone, FoodUsedArmy, FoodUsedEconomy, FoodUsedTechnology, FoodUsedUpgrade, FoodUpkeepLevel, MineralsCurrent, VespeneCurrent, MineralsCollected, VespeneCollected, MineralsSpent, VespeneSpent, MineralsReceived, VespeneReceived, MineralsDonated, VespeneDonated, MineralsCollectionRate, VespeneCollectionRate, MineralsFloatAverage, VespeneFloatAverage, MineralsUsedCurrentArmy, VespeneUsedCurrentArmy, MineralsKilledArmy, VespeneKilledArmy, MineralsLostNone, VespeneLostNone, MineralsLostArmy, VespeneLostArmy, MineralsLostEconomy, VespeneLostEconomy, MineralsLostTechnology, VespeneLostTechnology, MineralsLostUpgrade, VespeneLostUpgrade, MineralsFriendlyFireNone, VespeneFriendlyFireNone, MineralsFriendlyFireArmy, VespeneFriendlyFireArmy, MineralsFriendlyFireEconomy, VespeneFriendlyFireEconomy, MineralsFriendlyFireTechnology, VespeneFriendlyFireTechnology, MineralsFriendlyFireUpgrade, VespeneFriendlyFireUpgrade, MineralsUsedCurrentTechnology, VespeneUsedCurrentTechnology, MineralsUsedCurrentUpgrade, VespeneUsedCurrentUpgrade, LifeDamageDealtTotal, ShieldsDamageDealtTotal, LifeDamageTakenTotal, ShieldsDamageTakenTotal, LifeHealedTotal, ShieldsHealedTotal, LifeSpentTotal, ShieldsSpentTotal, EnergySpentTotal, MineralsUsedTotalEconomy, VespeneUsedTotalEconomy, MineralsUsedTotalTechnology, VespeneUsedTotalTechnology, MineralsUsedTotalUpgrade, VespeneUsedTotalUpgrade, MineralsUsedTotalArmy, VespeneUsedTotalArmy, MetaExperience, TotalMissionScore, ActionsAlliance, ActionsCommand, ActionsControlGroup, ActionsResourceTrade, ActionsSelect, ActionsTarget, CommandsAlliance, CommandsCommand, CommandsControlGroup, CommandsResourceTrade, CommandsSelect, CommandsTarget, CPMAverage, CustomCollected, CustomCollectionRate, CustomCurrent, CustomDonated, CustomFloatAverage, CustomFriendlyFireArmy, CustomFriendlyFireEconomy, CustomFriendlyFireNone, CustomFriendlyFireTechnology, CustomFriendlyFireUpgrade, CustomKilledArmy, CustomKilledEconomy, CustomKilledNone, CustomKilledTechnology, CustomKilledUpgrade, CustomLostArmy, CustomLostEconomy, CustomLostNone, CustomLostTechnology, CustomLostUpgrade, CustomReceived, CustomSpent, CustomUsedActiveForces, CustomUsedCurrentArmy, CustomUsedCurrentEconomy, CustomUsedCurrentNone, CustomUsedCurrentTechnology, CustomUsedCurrentUpgrade, CustomUsedInProgressArmy, CustomUsedInProgressEconomy, CustomUsedInProgressNone, CustomUsedInProgressTechnology, CustomUsedInProgressUpgrade, CustomUsedTotalArmy, CustomUsedTotalEconomy, CustomUsedTotalNone, CustomUsedTotalTechnology, CustomUsedTotalUpgrade, EnergyDamageDealtTotal, EnergyDamageTakenTotal, EnergyHealedTotal, MineralsKilledEconomy, MineralsKilledNone, MineralsKilledTechnology, MineralsKilledUpgrade, MineralsUsedActiveForces, MineralsUsedCurrentEconomy, MineralsUsedCurrentNone, MineralsUsedInProgressArmy, MineralsUsedInProgressEconomy, MineralsUsedInProgressNone, MineralsUsedInProgressTechnology, MineralsUsedInProgressUpgrade, MineralsUsedTotalNone, StructuresActiveArmy, StructuresActiveEconomy, StructuresActiveNone, StructuresActiveTechnology, StructuresCanceledValue, StructuresFriendlyFireValue, StructuresInProgressCount, StructuresQueuedCount, StructuresSalvagedValue, TerrazineCollected, TerrazineCollectionRate, TerrazineCurrent, TerrazineDonated, TerrazineFloatAverage, TerrazineFriendlyFireArmy, TerrazineFriendlyFireEconomy, TerrazineFriendlyFireNone, TerrazineFriendlyFireTechnology, TerrazineFriendlyFireUpgrade, TerrazineKilledArmy, TerrazineKilledEconomy, TerrazineKilledNone, TerrazineKilledTechnology, TerrazineKilledUpgrade, TerrazineLostArmy, TerrazineLostEconomy, TerrazineLostNone, TerrazineLostTechnology, TerrazineLostUpgrade, TerrazineReceived, TerrazineSpent, TerrazineUsedActiveForces, TerrazineUsedCurrentArmy, TerrazineUsedCurrentEconomy, TerrazineUsedCurrentNone, TerrazineUsedCurrentTechnology, TerrazineUsedCurrentUpgrade, TerrazineUsedInProgressArmy, TerrazineUsedInProgressEconomy, TerrazineUsedInProgressNone, TerrazineUsedInProgressTechnology, TerrazineUsedInProgressUpgrade, TerrazineUsedTotalArmy, TerrazineUsedTotalEconomy, TerrazineUsedTotalNone, TerrazineUsedTotalTechnology, TerrazineUsedTotalUpgrade, UnitsActiveArmy, UnitsActiveEconomy, UnitsActiveNone, UnitsActiveTechnology, UnitsCanceledValue, UnitsFriendlyFireValue, UnitsQueuedCount, UnitsSalvagedValue, VespeneKilledEconomy, VespeneKilledNone, VespeneKilledTechnology, VespeneKilledUpgrade, VespeneUsedActiveForces, VespeneUsedCurrentEconomy, VespeneUsedCurrentNone, VespeneUsedInProgressArmy, VespeneUsedInProgressEconomy, VespeneUsedInProgressNone, VespeneUsedInProgressTechnology, VespeneUsedInProgressUpgrade, VespeneUsedTotalNone, WorkersKilledCount, WorkersPeakCount, WorkersStartCount }
enum E_ScoreValueFlags { PerformanceMeasure, TriggerAchievement, PersistToDB, DisplayAsPercent, DisplayAsSigned, Hidden, MapMechanic, ProfileStat, SpecificHero }
enum E_VitalType { Maximum, Fraction, Delta, Current }
enum E_UnitTestState { Detector, InStasis, Hidden, Unselectable, Untargetable, Silenced, Stunned, EnergyRegenSuppressed, InsideTransport, NoDraw, Morphing, Idle, InsidePlayerTransport, InsideUnitTransport, AttackSuppressed, Hosting, AcquiringSuppressed, Alive, ApplyingFootprint, ArmorDisabled, ArmySelect, Beacon, Benign, BuildOnSuppressed, Buried, CameraFollowable, Cloaked, CloakSuppressed, CollisionDisabled, CombatSuppressed, CurrentlyRevivable, DamageVisibilitySuppressed, Dazed, Dead, Decaying, Destructible, Dying, FidgetingAllowed, GateEnforcementSuppressed, Hallucination, Harvesting, HarvestingCounted, Hero, HideWaypoints, Highlighted, HoldingPosition, IgnoredByPlacement, IgnorePlayerAlliedFlags, InMovementThinkAndAgeLoop, InProgress, InsideMagazine, Interactable, Interacting, InvulnerabilitySuppressed, Invulnerable, ItemUsageSuppressed, Jumping, Kiting, LifeRegenSuppressed, Magazine, Missile, MissileNullified, Movable, MovingImpossible, MovingSuppressed, OrderQueuePaused, OrderQueueUninterruptible, PassengerSuppressed, Passive, Pathing, Paused, Pawnable, PenaltyRevealed, PermanentlyInvulnerable, PlayerRevivable, Precursor, ProgressRevealed, ProvidingFood, PushingSuppressed, Radar, RequirementTestSuppressed, Resistant, Resource, ResourceDropOff, Revivable, SelectableWhileDead, ShieldRegenSuppressed, StartingUnit, StatsTrackAbilities, StatsTrackCreation, StatsTrackDamageDone, StatsTrackDamageReceived, Structure, Summoned, TechSuppressed, TownCamera, Transport, TreatStructureAsUnitForSelection, Turnable, TurningImpossible, TurningSuppressed, Unclickable, Uncloakable, Uncommandable, Uncursorable, UnderConstruction, Undetectable, Unhighlightable, Unradarable, Unstoppable, Untooltipable, UsingFood, VisionSuppressed, Worker, XPGainSuppressed, XPGrantSuppressed, XPSharingSuppressed }
enum E_ActorForceField { Directional, Radial }
enum E_ActorForceDirection { Forward, Up }
enum E_EffectRemoveBehaviorAlignment { Positive, Negative, Any, Neutral, None }
enum E_EffectContainer { Magazine, Transport, Any, Inventory }
enum E_CursorRangeMode { ForceToMax, Clamp, Normal }
enum E_AccumulatorOperation { Minimum, Subtract, Multiply, Maximum, Divide, Power, Add }
enum E_AccumulatorApplicationRule { AdditiveMultiply, Multiply, Add }
enum E_ActorTextAlignment { Bottom, Top, Center, Left, Right }
enum E_SoundBlend { Logarithmic, Linear, Inverse }
enum E_CargoSpace { Free, Load, Used, Size }
enum E_AMPatternType { Bounce, Stripe }
enum E_ImplementionLevel { Ready, Improgress, Locked, Planed, Reviewed, Rough }
enum E_VariationCommands { MoreBlue, MoreCyan, MoreGreen, MoreRed, MoreMagenta, Darker, MoreYellow, LessSaturation, Lighter, MoreSaturation }
enum E_TonemapRegionTypes { Midtone, Highlight, Dark }
enum E_PausedParticleSystemBehavior { Automatic, FreezeAll, Fade, Continuous, FreezeEmissionRate }
enum E_ActorSoundPlayMode { Random, Sequence, All }
enum E_CharacterRace { Terran, Zerg, XelNaga, Protoss }
enum E_ActorSoundValueSource { Sound, Actor, Combine }
enum E_UnitGender { Female, Neutral, Male }
enum E_AbilBuildType { AddOn, Normal, PlacementBuild }
enum E_AbilArmMagazineLaunch { ReleaseAtSource, ReleaseAtTarget, FireAtTarget }
enum E_ActorCrossbarDistribution { GaussianInverse, Gaussian, Uniform }
enum E_ActorIncomingType { Missile, Direct }
enum E_ActorRequestCreateSharing { PerEffectTree, Always, None }
enum E_ActorHeightSourceType { SyncAir, AsyncPrecise, SyncGround, AsyncFast }
enum E_ActorHeightTestType { Lowest, Highest, Average }
enum E_DamageResponseHandledValue { Original, Absorbed, None, Remaining }
enum E_AccumulatorBehaviorType { DurationRemaining, DamageModifyLimit, DamageModifyRemaining, DurationFraction, DurationTotal, StackCount }
enum E_ActorProximity { CenterActor, CenterModelBounds }
enum E_ActorSiteOrbiterType { Absolute, Relative }
enum E_DamageResponseDamageValue { Original, Remaining }
enum E_BehaviorBuffReplace { FarthestDistance, ShortestDuration }
enum E_DamageTotal { Minimum, Combine, Maximum }
enum E_KineticFollow { Position, Bearings }
enum E_BehaviorState { UnitAttrOnMapBoss, UnitAttrOnMassive, SuppressArmySelect, UnitAttrOnHover, UnitAttrOnHeroic, HideWaypoints, IgnorePlayerAlliedFlags, UnitAttrOffHeroic, SuppressItemUsage, Stun, SuppressCloak, SuppressInvulnerability, Hallucination, Summoned, SuppressEnergy, Untargetable, SuppressAttack, Invulnerable, Stasis, SuppressCollision, SuppressLifeRegen, SuppressShieldsRegen, Cloak, SuppressPassenger, Unstoppable, SuppressEnergyRegen, GenerateThreat, SuppressDetection, SuppressRadar, SuppressShields, SuppressCombat, Uncommandable, Undetectable, Unradarable, IsKiting, SuppressFoodMade, SuppressFoodUsed, SuppressRequirements, SuppressXPGain, SuppressXPGrant, SuppressXPSharing, Unselectable, SuppressTech, Bury, Passive, Benign, NoDraw, Silence, Daze, LineMovement, SuppressFidgeting, IgnoredByPlacement, Resistant, TransientMorph, UnitAttrOffLight, UnitAttrOffArmored, UnitAttrOffMassive, SuppressDropOff, Detector, SuppressThreat, UnitAttrOnUser1, RevealProgress, Radar, SuppressBuildOn, SuppressDamageVisibility, SuppressGateEnforcement, SuppressLife, SuppressUnitUseLineOfSight, UnitAttrOffBiological, UnitAttrOffHover, UnitAttrOffMapBoss, UnitAttrOffMechanical, UnitAttrOffPsionic, UnitAttrOffRobotic, UnitAttrOffStructure, UnitAttrOffSummoned, UnitAttrOffUser1, UnitAttrOnArmored, UnitAttrOnBiological, UnitAttrOnLight, UnitAttrOnMechanical, UnitAttrOnPsionic, UnitAttrOnRobotic, UnitAttrOnStructure, SuppressKillCredit, Ultravision, CannotDie }
enum E_AbilReviveVital { Maximum, Start, Ignore }
enum E_AMRandomDistribution { Uniform, Exponential }
enum E_FootprintShapeMode { Persist, Overlay, Regular }
enum E_DeathReveal { Vision, Snapshot }
enum E_EditorTextType { Name, Prefix, Suffix }
enum E_AchievementTagCheck { Present, Absent }
enum E_AchievementTermEvaluate { Expand, Failed, Attain, Always }
enum E_AchievementTermCombine { ValueAdd, ValueExpand, StateAdd }
enum E_ActorRadialDistribution { Exponential, Gaussian, Uniform }
enum E_ActorResponseScope { QueryDirector, QuerySubject }
enum E_ActorCombatRevealDurationType { ByVictim, OneShot }
enum E_CharacterGender { Female, Male }
enum E_CharacterRelevance { Minor, Major, Medium }
enum E_MuteControl { SoundEffects, SoundVoices, SoundAmbience, Music, Sound, SoundUI, SoundMovement, SoundReady }
enum E_VolumeControl { SoundEffects, SoundVoices, SoundAmbience, Music, SoundUI, SoundReady }
enum E_GlueTheme { Terran, Zerg, Protoss, Clouds, Karax, Nova, Abathur, Nova2, Alarak, NovaCommander, WCS2016, Nova3, Stukov, Fenix, Dehaka, Horner, Anniversary, Anniversary2018, Tychus, WCS2017, WCS2018, WCS2019, Zeratul, Stetmann, Mengsk, Latest, Random }
enum E_ScoreCollapse { Latest, Average, Maximize }
enum E_ScoreSort { Descending, Ascending }
enum E_ScoreValueOperation { Subtract, Add, Divide, Multiply }
enum E_ScoreValueReport { Samples, Average, Final }
enum E_ScoreValueType { Fixed, Integer, Time }
enum E_ExclusivityAction { Stomp, Fail, Queue }
enum E_ExclusivityQueueAction { Fail, Stomp }
enum E_VoiceOverSoundType { CustomName, CustomSuffix, Default, None }
enum E_AbilMorphPhase { Delay, Duration }
enum E_ActorPhysicsImpactRangeType { Impulse, CollisionArea, DontCare, RelativeApproachSpeed }
enum E_SerpentType { Swimming, Basic }
enum E_ActorSiteOpRotatorType { AddRotationChange, AccumulateAndSetRotation }
enum E_AbilMorphSection { Stats, Abils, Actor, Collide, Facing, Mover }
enum E_ActorSiteOpActionLocation { Launch, Impact, Center }
enum E_ActorSiteOpBasicType { ScopeBearings, ScopePosition, InitialBearings, ActorPosition, CreatorPosition, CreatorBearings, ActorBearings, WorldPosition }
enum E_ActorEffectLocation { CasterPoint, OriginPoint, MissileUnitOrPoint, SourcePoint, SourceUnit, CasterUnit, TargetPoint, TargetUnit, CasterUnitOrPoint, OriginUnit, OriginUnitOrPoint, OuterPoint, OuterUnit, OuterUnitOrPoint, SourceUnitOrPoint, TargetUnitOrPoint }
enum E_AMAttachType { NoKeywords, HasKeywords }
enum E_AMOccupancyLogic { RequireNone, PreferAny, PreferNone, RequireAny }
enum E_AMArcTestType { Preference, Absolute, FallbackToClosestOnArc }
enum E_AMFilterAttachType { Volume, Any, Point }
enum E_AMFilterType { Preference, Absolute }
enum E_AMReductionType { Percentage, Fixed }
enum E_CameraHeightMap { Camera, Air }
enum E_SoundFormat { PCM16, PCM24, PCM32, PCM8, PCMFLOAT }
enum E_SoundResampler { Linear, Cubic, None, Spline }
enum E_UIColorRelation { DefaultNeutral, Owner, Ally, Enemy, TeamHostile, TeamOrder, TeamChaos }
enum E_GameCategoryUsage { Melee, Arcade, MeleeStrict }
enum E_TargetModeValidation { Present, None, Strict }
enum E_WeaponType { MeleeOrRanged, Melee, Ranged }
enum E_SkillPoint { Current, Extra, Total, Used }
enum E_UnitAIFlag { ForceUnburrow, SuggestBurrow, SuggestUnburrow, ForcedToMove, WantsToMove, Campaign, ScriptControlled, Suicide }
enum E_PlayerRelationship { Enemy, Self, Ally, Neutral }
enum E_AbilBehavior { Toggle, Transient, BestUnit, ToggledOn, AutoCast, AutoCastOn, AutoCastOffOwnerLeave, AutomaticOn }
enum E_AbilEffect { ClearLastAttackTarget, ClearLastMoveTarget, TransportAcquirePassengers, AllowMovement, BestUnit, NoDeceleration, RequireTargetVision, Transient, AutoCast, AutoCastOn, AbortOnAllianceChange, AllowMovingSuppressed, AllowTurningSuppressed, CancelResetAutoCast, AutoCastOffOwnerLeave, TransientPreferred, PassengerAcquireExternal, PassengerAcquirePassengers, ReExecutable, Smart, UpdateChargesOnLevelChange, PassengerAcquireTransport, RangeUseCasterRadius, UninterruptibleTurn, ChannelingMinimum, RangeUsePathing, DeferCooldown, Chase, UpdateTarget, HomogenousInterrupt, IgnoreOrderPlayerIdInStageValidate, WaitToSpend, ReApproachable, LineMovement, ExternalAcquirePassenger }
enum E_ProgressButtonArray { Prep, Channel, Cast, Finish }
enum E_CancelEffect { Prep }
enum E_AbilityCategories { Aura, Passive, Heal, User1, CanBeDisabled, CanBeIllusionDisabled, User4, User3, Physical }
enum E_AbilBuild { InstantPlacement, PeonMaintained, PeonHide, RangeIncludesBuilding, PeonKillFinish, Interruptible, RequireFacing, PeonDisableCollision, PeonDisableAbils, ShowProgress, IgnoreFood, IgnoreUnitCost, PeonKillCancel, IgnoreUnitBuildTime, AutoHarvest, Cancelable, PeonCanBeMoved, BestUnit, HomogenousInterrupt, NeutralDetachedAddOn, PeonFidgetAcross }
enum E_EffectArray { Start, Create, Birth, Death, Cancel, Launch, Release, Finish, Return, Revive }
enum E_AbilTransport { IgnoreBlockers, CargoDeath, AllowPassengerSmartCmd, AllowSmartCmd, PlayerHold, ShowCargoSize, ShowStatus, AllowCorpse }
enum E_AbilMorph { DisableCollision, BestUnit, DisableAbils, FastBuild, Interruptible, Produce, ShowProgress, IgnoreFacing, IgnorePlacement, SuppressMovement, Automatic, WaitUntilStopped, AutoCast, AutoCastOn, MoveBlockers, Birth, IgnoreCollision, Transient, IgnoreUnitCost, RallyReset, Rally, IgnoreFood, ShowPlaceholder, AutoCastIdleOnly, AutoCastOffOwnerLeave, ProvideSourceUnitTech, AutomaticUnmorph, RequireAcquiredTarget, RequireAcquiredTargetUnmorph, Toggle }
enum E_SectionArray { Abils, Actor, Facing, Stats, Collide, Mover }
enum E_DurationArray { Delay, Duration }
enum E_ActorInherits { BaseModelScale, CastShadows, CloakEffect, CreepEngulfment, Decal, ModelMaterials, Opacity, Scale, TeamColor, TimeScale, TintColor, Visibility, WarpGroup, LocalTintColor }
enum E_ActorTransfer { Position, Rotation, Status, AnimProps, Textures, ModelMaterials, Animator, Model, FOWColor, FOWShader }
enum E_ActorFlags { VisionTestCenterOnly, SuppressSaveLoad, SuppressCreationErrors, RespondsToUnitPlayerChange, AddToExternalFinder, SkipPreload }
enum E_ImpactMap { None, Shield, Flesh, Metal, Miss, LightArmor, Rock, Dirt, Sand, Snow, Water, Wood }
enum E_ActorModel { SuppressPlayerDecals, AutomateGlobalLoops, AllowHitTest, OutlineEmitter, UseSyncSeed, NeedsVolumeMonitoring, OutlineOccluder, WireframeRender, UseSprayForDecal, UseConstSyncSeed, UpdateVisibility, AnimationsDontResetOnUnhide, SuppressMissingAttachErrors, CloakedUndetectedIsHidden, SuppressTextureErrors, AutomatedGlobalLoopsIgnoreOrphan, IgnoreWalkables, IgnoreTipabilityWithHostOrSiteOps }
enum E_ActionFlags { AlignedImpactsAndDamages, ImpactMonitorsTeleports, LaunchForceSite, IgnoresShields, ImpactForceSite, VictimRevealsAttacker, ImpactSuppressUnitSound }
enum E_ActorHostedPropTransfer { Decal, Scale, BaseModelScale, CastShadows, CloakEffect, CreepEngulfment, LocalTintColor, Opacity, TeamColor, TimeScale, TintColor, Visibility, WarpGroup, ModelMaterials }
enum E_DeathArray { Normal, Remove, Blast, Disintegrate, Eat, Electrocute, Eviscerate, Fire, Freeze, Impact, Morph, Reincarnation, Silentkill, Squish, Timeout, Unlink, UnderConstruction, Salvage, Cancel, TrainingComplete, TrainingCancel }
enum E_SoundArray { Ready, What, Help, Yes, Attack, Pissed, Birth, Movement, Turning, Board, Click, ClickError, Highlight, Construction }
enum E_UnitFlags { AutomateWalkDirections, ShowBlobShadow, StandAnimBirthVariation, SuppressStandIntro, SuppressWalkIntro, SuppressWalkOutro, SuppressDefaultStatusBar }
enum E_ActorFilter { Enemy, Ally, Neutral, All, Self }
enum E_GroupSoundArray { What, Yes, Attack, Board, Birth, Ready, Help, Pissed, Movement, Turning, Click, ClickError, Highlight }
enum E_Baselines { Walk, Stand }
enum E_ActorSquibMap { None }
enum E_RangeFlags { Minimap, GameWorld }
enum E_InfoFlags { Hidden, AlwaysUseGameText }
enum E_DisplayDuration { Self, Ally, Enemy, Neutral }
enum E_BehaviorModify { SuppressMoving, SuppressTurning, DisableAbils, Reveal, EnableAttack, EnableMove, HideChangeUI, DisableWeapons, Detected, ShareSight, OrdersUninterruptible, Warpable, Movement, OverrideAttackTargetPriority }
enum E_BuffFlags { Countdown, DisableWhileUnderConstruction, RemoveDamageResponseExhausted, Channeled, Channeling, Extend, RefreshStack, UpdateDurationWhileDisabled, LeechUseDamageResponseCondition }
enum E_BehaviorFlags { Permanent, EnabledWhileDead, IgnoreInEditor, Disabled }
enum E_HeightTime { Start, Stop }
enum E_TooltipFlags { ShowHotkey, ShowLevel, ShowResources, ShowSupply, ShowCooldown, ShowAutocast, ShowTime, ShowUsage, ShowRequirements, ShowRadius, ShowName, ShowDuration, ShowRange }
enum E_SearchFlags { ExtendByUnitRadius, OffsetByUnitRadius, SameCliff, CallForHelp, OffsetAreaByAngle, CenterAtLaunch, Multishot }
enum E_Response { Acquire, Flee }
enum E_Damage { NoZeroDamageInherit, Notification, Kill, NoKillCredit, NoDamageTimerReset, NoScaledDealtBonus, NoFractionDealtBonus, NoUnscaledDealtBonus, NoDealtMinimum, NoTakenMinimum, NoBehaviorResponse, NoVitalAbsorbShields, Impact, NoScaledTakenBonus, NoFractionTakenBonus, NoUnscaledTakenBonus, Live, NoLeech, NoGain, NoVitalLeechLife, NoVitalLeechShields, NoVitalLeechEnergy, NoVitalGainLife, NoVitalGainShields, NoVitalGainEnergy, NoDealtMaximum, NoTakenMaximum, NoVitalAbsorbLife, NoVitalAbsorbEnergy, ValidateImpactDeflection }
enum E_CreateFlags { PlacementIgnoreBlockers, Precursor, ProvideFood, SetFacing, TechComplete, UseFood, Birth, OffsetByRadius, Placement, NormalizeSpawnOffset, DropOff, PlacementIgnoreCliffTest, SelectControlGroups, PlacementOriginSideOfFootprints, OffsetUnitTypeByLevel }
enum E_EffectCreatePersistent { Channeled, RandomOffset, PersistUntilDestroyed, EffectSuccess, RandomPeriod, EffectFailure, OrphanParams, Channeling, RandomEffect }
enum E_TeleportFlags { TestFog, TestZone, TestCliff }
enum E_ModifyFlags { DropFromContainerPassenger, Hide, NullifyMissile, SetVitals, IsHeal, Remove, Copy, InterpolateFacing, Owner, Show, Revive, Mimic, Salvage, CopyAutoCast, ClearLastAttackTarget, ClearLastMoveTarget, DropFromContainerItem, PauseDeathTime, ResourceDrop, StartingVitals, UnpauseDeathTime, Unraisable }
enum E_EffectReveal { Unfog, Detect, LoS, Permanent, Radar }
enum E_EffectApplyBehavior { SetAttributeBasePoints, SetAttributePoints, SetAttributePointsDelta, UseDuration }
enum E_EffectLaunchMissile { PlacementIgnoreBlockers, TravelValidation, ValidateWeapon, '2D', Retarget, Return, Placement, PlacementIgnoreCliffTest, PlacementOriginSideOfFootprints, Channeled, ValidateAbil, ValidateBenign, ValidateTeleport, PointFallback, Transfer, ValidateImpactDeflection }
enum E_NotifyArea { HurtEnemy, HurtFriend, MinorDanger, MajorDanger, HelpFriend, OnlyWorkers }
enum E_Cmd { Alternate, Queued, Preempt, SmartClick, SmartRally, Subgroup, SetAutoCast, SetAutoCastOn, User, DataA, DataB, AI, AIIgnoreOnFinish, IsOrder, Script, HomogenousInterruption, Minimap, Repeat, DispatchToOtherUnit, TargetSelf, Continuous, QuickCast, AutoQueued, AIHeroes, BuildOnSelf, ToSelection, AttackOnce }
enum E_DirectionalLight { Key, Fill, Back }
enum E_SAttachPropsKeys { CustomB, Hardpoint, Turret, SetA, SetB, Weapon, SetC, Work, Target, Shield, Ground, CustomA, Xil, Air, Agria, Aiur, Albion, Alternate, Armor, Attacher, Avernus, Back, BelShir, Bottom, Cargo, Castanar, Center, Channel, Char, Chest, Chin, CustomC, Damage, Death, Dylar, Effector, Engine, Face, Final, Foot, Forearm, Front, Hand, Haven, Head, Heavy, Hit, HPBar, IGNORE, Knee, Korhal, Left, Light, Lip, MacGuffin, MarSara, Medium, Meinhoff, Monlyth, Moria, Mount, Movement, NewFolsom, Origin, Overhead, PortZion, Primary, PU72516J, RallyPoint, Rear, Redstone, Right, Secondary, Shoulder, StatusBar, TargetShield, Tarsonis, Top, Transmission, TurretY, TurretZ, Tyrador, Umoja, Upgrade, Upper, Valhalla, Waist, EatTree }
enum E_Race { TrialAllowed, Selectable }
enum E_StartingUnit { ResourceSetRally, ResourceRally }
enum E_Requirement { Use, Show }
enum E_Upgrade { TechTreeCheat, UpgradeCheat, IgnoreInvalidReferenceInTemplate, EnumDataCollectionUnits }
enum E_WeaponOptions { Hidden, OnlyFireWhileInAttackOrder, OnlyFireAtAttackOrderTarget, Disabled, ContinuousScan, LinkedCooldown, RequireEnabledAttackAbil, Melee, NeverMiss, DisplayCooldown, IgnoreThreat, IgnoreAttackPriority, CanInitiateAttackOrder, HoldFileInShrubs }
enum E_WeaponLegacyOptions { LockTurretWhileFiring, FaceTargetWhileInCooldown, NoDeceleration, Uninterruptible, CanRetargetWhileChanneling, KeepChanneling, UseRangeToCenter }
enum E_AbilAugment { AutoCast, AutoCastOn, Smart, AutoCastOffOwnerLeave, BestUnit }
enum E_AbilShared { IgnoreProduceLimit, SkipPreload, TargetCursorVisibleInBlackMask, TargetCursorHiddenForInvalidTargets, RegisterCooldownEvent, RegisterChargeEvent, DisableWhileDead, TargetSnapToUnitRadius, Disabled }
enum E_AbilArmMagazine { AutoCreate, Retarget, Transient, AutoCastOffOwnerLeave, BestUnit, ShowStatus, WaitForFood, IgnoreUnitCost, UnitOrderQueue }
enum E_AbilArmMagazineInfo { AutoBuild, AutoBuildOn, LeashRetarget, External }
enum E_Charge { RestoreAllChargesOnCooldown, EnableChargeTimeQueuing, IgnoreTimeDelay }
enum E_CliffLevelCompare { Higher, Lower, Equal }
enum E_TerrainSquibVisual { OneShot }
enum E_AlertFlags { SoundFromLocalPlayer, Hide, Ping, Combine }
enum E_AlertDisplay { Self, Other, Enemy, Ally, Observer, Neutral }
enum E_BehaviorPowerUser { DisplayPower, HideUnpoweredText, LevelFromSourceCount, KillIfUnpowered, LevelFromAbilLevel }
enum E_EffectCreateHealer { Channeled, SuppressShieldsRegen, ContinueWhenFull, Channeling }
enum E_EffectModifyTurret { ClearTarget, Tracking, ClearTargetOnAimComplete }
enum E_SelectionTransfer { IncludeControlGroups, DeselectSource, SingleOnly }
enum E_Negative { BoostHeight, NoCanSee, NoBuild, BlockVision, NearResources, Creep, Masked, Water, Fogged, NoCreep, DropOff, GroundNoSpawn, Dense, ShrubVision }
enum E_Positive { BlockVision, NoBuild, DropOff, GroundNoSpawn, NearResources, Creep, Dense, Water, BoostHeight, NoCreep, NoCreepPermanent, NoCanSee, BoostCliff, ShrubVision }
enum E_Mover { IgnoreMovementSuppression, IgnoreNoFlyZones, RestoreHeight }
enum E_AdaptableParabolaDistances { Launch, PreApex, PostApex, Land }
enum E_AdaptableParabolaAccels { Launch, Ascent, Apex, Descent, Land }
enum E_TargetFind { EvaluateCmd }
enum E_Editor { NoPlacement, NoPalettes, BlockStructures, HostileDefault, AmbientOcclusion, CanRotate, NeutralDefault, NoAutoRotate }
enum E_AbilQueue { Passive, Hidden, BestUnit, NotifyAddOn }
enum E_AbilMerge { IgnoreUnitCost, BestUnit }
enum E_AlertArray { Cast }
enum E_ForceFlags { Stacks, FallOff }
enum E_RateMultiplierArray { Queueable, Progress, Charge, Morph, Spawn, Creep, Cooldown }
enum E_Texture { UnifyWithInnateModelTextures }
enum E_UnitTrackerFlags { UseSharedList, SharedListPersistsForever, SnapPlacement, SnapUnitToCircumference }
enum E_BehaviorResource { RemoveWhenEmpty, HideHarvesters }
enum E_MorphFlags { IgnoreFacing, IgnorePlacement, IgnoreMorphing, RallyReset }
enum E_EffectCancelOrder { Queued, Active, Uninterruptible }
enum E_ActorVisibleTo { Neutral, Enemy, Self, Ally, All }
enum E_EffectBehavior { UseDuration }
enum E_CancelDelay { Cast }
enum E_AbilResearch { SmartRequirement, BestUnit, Transient, UnitOrderQueue }
enum E_AbilTrain { Transient, IgnoreUnitBuildTime, DisableCollision, KillOnCancel, KillOnFinish, Select, WaitForFood, BestUnit, AutoCastOffOwnerLeave, IgnoreUnitCost, UnitOrderQueue, IgnoreUnitStockCharge, BypassFoodRestriction, ChargeCasterPlayer, CopyLifePercentage }
enum E_AbilRedirectInstant { IncludeSelf }
enum E_AbilHarvest { BypassResourceQueue, NoExtract }
enum E_UseBuildTimeArray { Delay, Duration }
enum E_ShadowFlags { NoLowerThanBaseHeight, NoLowerThanWater }
enum E_DamageResponseCategory { Shield, Enhancement, Evasion, Proc, Reduction, CorpseUsage }
enum E_AttackTypeResponse { Chaos, Hero, Magic, None, Normal, Pierce, Siege, Spell }
enum E_ConjoinedFlags { ShareLife, ShareAcquire, ShareSelect, ShareVisible, ShareEnergy, ShareShields }
enum E_InfoIds { Text, Value, Model, Upgrade, AbilCmd }
enum E_EquipmentDisplay { DisplayRounded, CollapseBuffed, ExpandUpgraded }
enum E_DisplayShield { Self, Ally, Neutral, Enemy }
enum E_Reward { Allowed, ExcludeInLargeFormatGame, Default, Cloaked, Hidden, AlwaysUseUnearnedDescription, Promotion }
enum E_AbilSpecializeInfo { AutoCast, AutoCastOn }
enum E_AbilTrainInfo { InheritRally, IgnorePlacement, AutoCast, AutoCastOn }
enum E_AbilWarpTrain { WarpTrainersButton, IgnoreRampTest, IgnoreUnitCost, CmdToMostCharges }
enum E_ActorDoodad { DefaultToModelAABBBounds, FootprintOnly, PauseAnimsWhileFogged }
enum E_ActorPhysicsData { ExpectsOtherForces }
enum E_SoundFlags { UpdateVisibility }
enum E_AlertPrimaryActions { Flash, Select, View }
enum E_AlertSecondaryActions { Flash, Select, View, Target }
enum E_BehaviorSpawn { KillSpawnedOnDeath, HideCount, IgnoreMorph }
enum E_PlacementArray { Prevent, Require }
enum E_PathingDataBits { GroundNoSpawn, Creep }
enum E_PathingType { Ground, WaterShallow, Building, Cliff, None, WaterDeep }
enum E_ValidatorUnitCompareAttackPriority { IsThreat }
enum E_ValidatorUnitDetected { Normal }
enum E_AbilLearn { HideOnMaxLevel, Transient, BestUnit, HideOnPointsSpent, UnitOrderQueue, ClearSubmenuOnPointsSpent, HideSubmenuOnLearnedAll }
enum E_AbilRevive { WaitForFood, BestUnit, UnitOrderQueue, OverrideAlertIcon, Transient }
enum E_AbilInteract { AutoCast, ShareControl, Smart, BestUnit, SameCliffLevel, Exclusive, ShareVision, AlwaysShowCommandCard }
enum E_AbilMove { UpdateTarget, ShowIfImmobile }
enum E_AbilStop { HoldFire }
enum E_BoostedHeight { Air, Glide, Ground }
enum E_TerrainDeformerFlags { RestoreOnDestroy, DestroysFoliage, UseUnitFootprint, RestoreOnMovement, RestoreOnHidden }
enum E_BehaviorVeterancy { Global, MaxLevelLeech, CombineNumericModifications, CombineXP }
enum E_SharedXPRadius { Kills }
enum E_SharedXPFraction { Kills }
enum E_Item { KillWhenDepleted, DropOnDeath, CanDrop, EnabledWhileDead, IncludeInLootItemPool, UseItemCharge, UseItemGroupCooldownLink }
enum E_UserField { Modifiable, ConvState }
enum E_AbilSpecialize { UnitOrderQueue, AutoCastOffOwnerLeave, BestUnit, Transient }
enum E_AbilRally { ShowWhileMerging, ShowWhileWarping }
enum E_Achievement { Repeatable, Finalize, Local, Progress, Enabled, Hidden, Cloaked, Callout, Victory }
enum E_AchievementFilters { MapMelee, MatchNoHandicaps, MatchNoAIBuilds, MatchAnonymous, MatchMulti, MatchRanked, MatchSingle, MatchFFA, MatchObserver, MatchParticipant, MapSignature, MatchNoExtensions }
enum E_AchievementTerm { Hidden, Notify, Persist }
enum E_Bundle { ShowDynamicProductContent, IsFeatured, IsFeaturedLarge, ExternalSource, SuppressDiscount }
enum E_ObjectStates { Speaker, Listener, Camera }
enum E_ConversationState { AllowConditions, AllowActions, Sorted }
enum E_Footprint { CheckAll }
enum E_PlayerLeave { ClearSelection, FinalizeScore, ForcedAlliance, FulfillResourceRequests, ReportScore, SplitResources }
enum E_BeaconInfoArray { Army, Defend, Attack, Harass, Idle, Auto, Detect, Scout, Claim, Expand, Rally, Custom1, Custom2, Custom3, Custom4 }
enum E_Clear { Defend, Attack, Harass, Idle, Auto, Army }
enum E_GameUIMixRouting { User21, User22, User23 }
enum E_AnimFile { Override }
enum E_ScoreResult { Hidden }
enum E_SoundMixSnapshot { ApplyCategoryDuckingGlobal, ApplyCategoryDuckingNonLocal }
enum E_Mix { Test, ME, Movie, TV, Dialogue, Mission, Music, Other, Ambient, SAmbient, Alert, Death, Ready, Spell, SpellOneshotImpact, SpellOneshotLaunch, Combat, Voice, Message, UI, UIMovie, Flames, Build, Gather, Doodad, SEmitters, SPieces, Foley, Movement, User1, User2, User3, User4, User5, User6, User7, User8, User9, User10, User11, User12, User13, User14, User15, User16, User17, User18, User19, User20, User21, User22, User23, User24, User25, User26, User27, User28, User29, User30, User31, User32, User33, User34, User35 }
enum E_Soundtrack { Continuous, Instant }
enum E_AbilCategories { Passive }
enum E_BehaviorPowerSource { ProvidePowerWhileUnderConstruction }
enum E_ParamInitial { FarClip, FieldOfView, NearClip, ShadowClip, Distance, Pitch, Yaw, FocalDepth, FalloffStart, FalloffEnd, HeightOffset }
enum E_DiffuseColor { Key, Fill, Back }
enum E_DiffuseMultiplier { Key, Fill, Back }
enum E_CreepSettingsArray { Low, Medium, High, Ultra, Extreme }
enum E_SerpentAggregate { UseAttachDistances }
enum E_AbilRedirect { IncludeSelf }
enum E_AbilInventory { CanUseItem, CanStackItem, CanApplyEquipBehavior, ItemDeath, ItemDropOnDeath }
enum E_AbilAttackModifier { AutoCast, AutoCastOffOwnerLeave, AttackOnce, AutoCastOn, BestUnit, Smart }
enum E_ActorQuad { IgnoreLaunchAndImpactForHeight, AlignVerticallyOnOrigin, ForwardAnimMsgsCenterActor, ForwardAnimMsgsDecorationActor, ForwardAnimMsgsImpactActor, ForwardAnimMsgsLaunchActor, PreserveProportionsDuringWidthScaling, RespectWidthScaling }
enum E_SelectionFlags { UseCrescent, IsSyncSelection, IsFlash, UseCheapQuadSplat }
enum E_SelectionFilter { TandemFollowers, Observers, TandemLeaders, NonTandemPlayers }
enum E_CloakTransitionArray { None, Ally, Detected, Enemy }
enum E_StateArray { Ally, Detected, Enemy, None }
enum E_TerrainAndWaterFlags { PassThroughIfNoWater, FollowWaves }
enum E_TipabilityFlags { NoLowerThanScope, NoLowerThanBaseHeight }
enum E_RegionFlags { UseEffectRange }
enum E_Tests { Weapon, ActionAcquisition }
enum E_AttackModifierFlags { HallucinationVisualOnly, Critical, NeverMiss, OnlyApplyDamageBonusToValidTargets }
enum E_ShareFilters { DamageDealt, DamageTaken, Kills }
enum E_TargetFilters { DamageDealt, DamageTaken, Kills }
enum E_XPFraction { Kills }
enum E_SCameraZoomParam { Distance, Pitch, HeightOffset, BokehFStop, BokehMaxCoC, DepthOfField, DoFType, FalloffEnd, FalloffEndNear, FalloffStart, FalloffStartNear, FarClip, FieldOfView, FocalDepth, NearClip, Roll, ShadowClip, Yaw }
enum E_ParamSmooth { FieldOfView, NearClip, FarClip, ShadowClip, Distance, Pitch, Yaw, Roll, HeightOffset, DepthOfField, FocalDepth, FalloffStart, FalloffEnd }
enum E_SUIColorEntry { Default, Colorblind }
enum E_CreepFlags { Permanent, Ideal, Immediate, RemoveCreep }
enum E_DifficultyLevel { TrialAllowed }
enum E_TeleportResetRange { Weapon }
enum E_SoundQuality { Herds }
enum E_GameUIDefaultPathColor { World, Minimap }
enum E_GameUIDefaultPathLineWidth { World, Minimap }
enum E_GameUIDefaultPathTexture { World, Minimap }
enum E_GameUIDefaultPathTileLength { World, Minimap }
enum E_GameUIDefaultPathStepModel { World }
enum E_GameUIDefaultPathStepModelScale { World }
enum E_GameUIPointModels { Normal, StartLoc }
enum E_GameUIOverrideColors { SelfMinimap, Self, Ally, Hostile, Neutral }
enum E_GameUIColorBlindColors { SelfMinimap, Self, Ally, Hostile, Neutral }
enum E_GameUIBehaviorIconColors { Neutral, Positive, Negative }
enum E_GameUIBehaviorBorderColors { Neutral, Positive, Negative }
enum E_GameUISelectionColors { Subgroup, Selected, Ally, Enemy }
enum E_GameUISelectionColorBlindColors { Subgroup, Selected, Ally, Enemy }
enum E_DefaultGameVariantOptions { Custom, Premade, Default, FreeForAll, Coop }
enum E_Hero { Flyer, Random, UsesMount, ExcludeFromMapIntro, GoodForModeA, GoodForModeB, AllowAIRandomSelection, ShowInStore }
enum E_Preload { Automatic, Instantiate, MapCampaign }
enum E_FoliageSettingsArray { Low, Medium, High, Ultra }
enum E_SamplingDistance { Grass, Shrubs, Trees }
enum E_AcceptWorldForces { Shrubs, Trees, Grass }
enum E_HeightFlags { AirSmoothing }
enum E_Tile { Conform }

enum E_SiteFlags { RequiresManualKill }
enum E_ActorTiltType { NoMover, Any, Mover }
enum E_ArmyCategory { Hidden }
enum E_DamageTypeResponse { Magic, Acid, Cold, Death, Defensive, Demolition, Disease, Divine, Enhanced, Fire, Force, Lightning, Mind, None, Normal, Plant, Poison, ShadowStrike, SlowPoison, Sonic, SpiritLink, Universal }
enum E_ConversationConditionOp { NotEqual, GreaterEqual, LessEqual, Greater, Less, Equal }
enum E_ConversationSelectionMethod { Random, Sequence, Multiple, All }
enum E_ConversationConditionCheck { Any, All }
enum E_PathingConfig { InvulnerableBuildingAsBlocker }
enum E_SoundExclusivity { SupressionInterrupts }
enum E_TextTagEdge { Top, Right, Left, Bottom }
enum E_BankConditionCombine { Or, And }
enum E_ConversationActionOp { Add, Set, Subtract }
enum E_ModelFlags { Require3DPortrait }
enum E_AbilInventoryAlignment { Left, Right }
enum E_AbilLastTarget { Attack, Automatic, Move, Gather }
enum E_ActorQuadDecoration { UseLaunchActorScale }
enum E_RewardArray { Mutagen, DNA, Infestation }
enum E_AbilBehaviorCycleMode { Normal, Random, RandomNoRepeat }
enum E_AbilTrainLocation { Rally, Source }
enum E_AbilTrainRotation { Source, Target }
enum E_AchievementTermPrevious { Add, Expand, Ignore }
enum E_ActorModelMaterialType { Glaze, Replacement }
enum E_MinimapShape { Circle, Quad }
enum E_ActorSiteBillboardType { Unobstructable, UseTowardsCameraDistance }
enum E_ActorSiteOpAttachSource { Automatic, Chain, Host }
enum E_ActorSiteOpOrientAttachPointToType { Bearings, Position, Rotation }
enum E_ActorSiteOpPhysicsImpactType { Normal }
enum E_AMNumericField { RadiusShield, RadiusTarget }
enum E_AMNumericFieldOp { Equals, GreaterThan, GreaterThanOrEqual, LessThan, LessThanOrEqual }
enum E_Oscillator { Noise, SawDown, SawUp, Sine, Square, Triangle }
enum E_MoverPatternType { Bounce, Stripe }
enum E_BehaviorHeroicState { Any, Heroic, NonHeroic }
enum E_FoliageLayer { Brush, Grass, Tree }
enum E_PurchaseWarningCondition { Always, Recruit }
enum E_ResponseContinueMethod { Always, Break, Failure, Success }
enum E_PreloadTiming { Blocking, Immediate, NextSession, Offscreen, ThisSession }
enum E_GameResult { Defeat, Tie, Undecided, Victory }
enum E_ActorModelAspectPerson { Any, Observer, Participant, Referee, Spectator }
enum E_ActorModelAspectObservingPoV { Any, DefaultObservedPlayerId, Everyone, PlayerId, TeamId }
enum E_ActorModelAspectRegardsAs { Enemy, Neutral, Ally, Self, Any, Friendly, NotSelf, Teammate }
enum E_ActorModelAspectDuring { Any, LiveGame, LiveGameHijacked, LiveGameNotHijacked, Replay }
enum E_ActorModelAspectObservedPlayerType { Any, Computer, Human, HumanObserver, HumanParticipant }
enum E_ActorModelAspectModelOwnerType { Any, Computer, Human }
enum E_ActorModelAspectTest { Message, None }
enum E_ActorQuadDecorationFunction { Bias, Gain, Linear }
enum E_ActorIntersectType { AgainstCenter, AgainstCenterGame, AgainstRadiusContact, AgainstRadiusGame, AgainstRadiusVisual }
enum E_ActorAnimTransitionType { ClearToPlay, ClearWhilePlaying, PlayWhilePlaying }
enum E_ActorAnimPropMatchType { Contains, FullMatch }
enum E_SpeakerMode { LFE, Stereo, BackLeft, BackRight, FrontLeft, FrontRight, Center, SideLeft, SideRight }
enum E_SoundMaxMethod { Prevent, Replace }
enum E_ModelQuality { High, Any, Low }
enum E_PhysicsMaterial { Bone, ClothHeavy, ClothLight, Creep, Dirt, EnergyShield, Flesh, Hair, Ice, Lava, LightArmor, MetalHeavy, MetalLight, MetalProtoss, Paper, Plastic, Rock, Rubber, Sand, Snow, Water, Wood }

enum E_RequirementState { Total, InProgressOnly, QueuedOrBetterAtUnit, QueuedOrBetter, CompleteOnlyAtUnit, CompleteOnly, InProgressOrBetter, InProgressOrBetterAtUnit, InProgressOnlyAtUnit, Revivable, Killed, Kills, Peak, QueuedOnly, QueuedOnlyAtUnit, QueuedOrBetterOrRevivable }
enum E_VoiceOverSkinState { Disabled, Shared, Unshared }
enum E_SoundMaxPrioritization { Age, Distance }
enum E_QuickCastMode { Off, On, OnUp }
enum E_HerdClosestTo { Camera, Listener }
enum E_BehaviorUnitTrackerSnapRule { Closest, Random }
enum E_ArtifactType { Gem, Glyph, Trinket }
enum E_ActorForceOrigin { AtBottom, AtCenter }
enum E_ActorPlayerIdSource { ContainingScope, Auto }
enum E_ActorSiteOpTetherEnableType { Disabled, Max, Min, MinMax }
enum E_AbilAttackStage { Approach, Attack, Loiter }
enum E_AbilBehaviorStage { Untoggled, Toggled }
enum E_AbilBuildStage { Approach, Wait, Construct, Halt, Resume, Finish, Collide }
enum E_AbilEffectStage { Approach, Wait, Prep, Cast, Channel, Finish, Bail }
enum E_AbilHarvestStage { ApproachResource, WaitAtResource, Harvest, WaitToReturn, WaitForDropOff, ApproachDropOff, DropOff }
enum E_AbilMorphStage { Approach, Wait, AbilsStart, AbilsEnd, ActorStart, ActorEnd, CollideStart, CollideEnd, FacingStart, FacingEnd, MoverStart, MoverEnd, StatsStart, StatsEnd, UnitStart, UnitEnd }
enum E_AbilRallyStage { Place }
enum E_AbilArmMagazineCmd { Ammo1, Ammo2, Ammo3, Ammo4, Ammo5, Ammo6, Ammo7, Ammo8, Ammo9, Ammo10, Ammo11, Ammo12, Ammo13, Ammo14, Ammo15, Ammo16, Ammo17, Ammo18, Ammo19, Ammo20 }
enum E_AbilAttackCmd { Execute, Towards, Barrage }
enum E_AbilAttackModifierCmd { Execute }
enum E_AbilAugmentCmd { Execute }
enum E_AbilBatteryCmd { Execute }
enum E_AbilBeaconCmd { Cancel, Move }
enum E_AbilBehaviorCmd { On, Off }
enum E_AbilBuildCmd { Build1, Build2, Build3, Build4, Build5, Build6, Build7, Build8, Build9, Build10, Build11, Build12, Build13, Build14, Build15, Build16, Build17, Build18, Build19, Build20, Build21, Build22, Build23, Build24, Build25, Build26, Build27, Build28, Build29, Build30, Halt }
enum E_AbilBuildableCmd { Cancel, Halt }
enum E_AbilEffectInstantCmd { Execute, Cancel }
enum E_AbilEffectTargetCmd { Execute, Cancel }
enum E_AbilHarvestCmd { Gather, Return, Cancel }
enum E_AbilInteractCmd { Designate }
enum E_AbilInventoryCmd { Drop, Move, Take, ItemInstant, ItemTarget, ItemCancel, PawnInstant, ItemTogOn, ItemTogOff }
enum E_AbilLearnCmd { Learn1, Learn2, Learn3, Learn4, Learn5, Learn6, Learn7, Learn8, Learn9, Learn10, Learn11, Learn12, Learn13, Learn14, Learn15, Learn16, Learn17, Learn18, Learn19, Learn20 }
enum E_AbilMergeCmd { SelectedUnits, WithTarget }
enum E_AbilMorphCmd { Execute, Cancel, Unmorph }
enum E_AbilMergeableCmd { Cancel }
enum E_AbilMoveCmd { Move, Patrol, HoldPos, AcquireMove, Turn }
enum E_AbilPawnCmd { Pawn1, Pawn2, Pawn3, Pawn4, Pawn5, Pawn6, Pawn7, Pawn8, Pawn9, Pawn10, Pawn11, Pawn12, Pawn13, Pawn14, Pawn15, Pawn16, Pawn17, Pawn18, Pawn19, Pawn20 }
enum E_AbilQueueCmd { CancelLast, CancelSlot }
enum E_AbilRallyCmd { Rally1, Rally2, Rally3, Rally4 }
enum E_AbilRedirectInstantCmd { Execute }
enum E_AbilRedirectTargetCmd { Execute }
enum E_AbilResearchCmd { Research1, Research2, Research3, Research4, Research5, Research6, Research7, Research8, Research9, Research10, Research11, Research12, Research13, Research14, Research15, Research16, Research17, Research18, Research19, Research20, Research21, Research22, Research23, Research24, Research25, Research26, Research27, Research28, Research29, Research30 }
enum E_AbilReviveCmd { Revive1, Revive2, Revive3, Revive4, Revive5, Revive6, Revive7, Revive8, Revive9, Revive10, Revive11, Revive12, Revive13, Revive14, Revive15, Revive16, Revive17, Revive18, Revive19, Revive20, ReviveAtTarget1, ReviveAtTarget2, ReviveAtTarget3, ReviveAtTarget4, ReviveAtTarget5, ReviveAtTarget6, ReviveAtTarget7, ReviveAtTarget8, ReviveAtTarget9, ReviveAtTarget10 }
enum E_AbilSpecializeCmd { Specialize1, Specialize2, Specialize3, Specialize4, Specialize5, Specialize6, Specialize7, Specialize8, Specialize9, Specialize10, Specialize11, Specialize12, Specialize13, Specialize14, Specialize15, Specialize16, Specialize17, Specialize18, Specialize19, Specialize20 }
enum E_AbilStopCmd { Stop, HoldFire, Cheer, Dance, Tease, RequestPickup }
enum E_AbilTrainCmd { Train1, Train2, Train3, Train4, Train5, Train6, Train7, Train8, Train9, Train10, Train11, Train12, Train13, Train14, Train15, Train16, Train17, Train18, Train19, Train20, Train21, Train22, Train23, Train24, Train25, Train26, Train27, Train28, Train29, Train30 }
enum E_AbilTransportCmd { Load, UnloadAll, UnloadAt, UnloadUnit, LoadAll }
enum E_AbilWarpableCmd { Cancel }
enum E_AbilWarpTrainCmd { Train1, Train2, Train3, Train4, Train5, Train6, Train7, Train8, Train9, Train10, Train11, Train12, Train13, Train14, Train15, Train16, Train17, Train18, Train19, Train20 }
enum E_AbilityCategory { User1, User2, User3, User4, User5, Magic, Physical, Aura, Passive, Dispel, PassivePhysical, PassiveMagic, Heal, SpellSteal, Repair, Polymorph, BlockByMorph, Ultimate, CanBeDisabled, CanBeSilenced, CanBeIllusionDisabled }
enum E_UnitStatusGroup { Owner, Allied, Enemy, All }
enum E_UnitStatus { Shields, Life, Energy, Cargo, Progress, Duration, Magazine, Workers, Custom, Charges }
enum E_FlyerDisplay { None, Selected, All }
enum E_ArmyCategoryState { Locked, Unlocked }
enum E_ArmyUnitState { Locked, Unlocked, Purchased, Disabled }
enum E_ArmyUpgradeState { Locked, Unlocked, Purchased, Disabled }
enum E_BehaviorCategory { Permanent, Restorable, Temporary, Cloak, Invulnerable, Slow, Fast, Stun, Reveal, Magic, Physical, Aura, Passive, PassiveMagic, TeleportRemove, CanSteal, TimedLife, User1, User2, User3, User4, User5, User6, User7, User8, User9, User10, User11, User12, User13, User14, User15 }
enum E_AttackModifierStage { Init, Idle, Waiting, Applied, Fired }
enum E_DamageLocation { Attacker, Defender }
enum E_UIColorMode { Default, Colorblind }
enum E_CommanderTalentType { Passive, Ability, Bundle, Unit }
enum E_CommanderMasteryTalentType { None, Seconds, Percent }
enum E_PortraitOverlayType { Level, HeroLeague, TeamLeague }
enum E_AllianceId { Passive, Vision, Control, Spend, Trade, SeekHelp, GiveHelp, Chat, Defeat, Pushable, Power }
enum E_AlliancePlayer { Control, Upkeep }
enum E_FlagOperation { Set, Clear, Toggle }
enum E_PlayerType { None, User, Computer, Neutral, Hostile }
enum E_TargetFilter { Self, Player, Ally, Neutral, Enemy, Air, Ground, Light, Armored, Biological, Robotic, Mechanical, Psionic, Massive, Structure, Hover, Heroic, User1, Worker, RawResource, HarvestableResource, Missile, Destructible, Item, Uncommandable, CanHaveEnergy, CanHaveShields, PreventDefeat, PreventReveal, Buried, Cloaked, Visible, Stasis, UnderConstruction, Dead, Revivable, Hidden, Hallucination, Invulnerable, HasEnergy, HasShields, Benign, Passive, Detector, Radar, Stunned, Summoned, Unstoppable, Outer, Resistant, Silenced, Dazed, MapBoss, Decaying, Raisable, HeroUnit, NonBuildingUnit, GroundUnit, AirUnit, Powerup, PowerupOrItem, NeutralHostile }
enum E_MarkerMatch { Id, Link, CasterPlayer, CasterUnit }
enum E_HeightMap { Air, Glide, Ground }
enum E_Plane { Ground, Air }
enum E_AbilCmd { CreateDefaultButton, ToSelection, ShowInGlossary, UseDefaultButton, Hidden, HidePath, AllowMinimap, AllowSelfCast, IgnoreUser, Continuous }
enum E_PlacementTest { Creep, Power, Fog, IgnoreBlockers, IgnoreInvisible, Zone, Cliff, Density, OriginSideOfFootprints }
enum E_UnitUserFlag { Unit, ArmyUnit, Hero, Building, Ancient, Ward, Item, Powerup, Projectile, Destructible, Tree, Bridge, CanSleep, User14, User15, User16 }
enum E_UnitVital { Life, Shields, Energy }
enum E_DamageType { Normal, Enhanced, Fire, Cold, Lightning, Poison, Disease, Divine, Magic, Sonic, Acid, Force, Death, Mind, Plant, Defensive, Demolition, SlowPoison, SpiritLink, ShadowStrike, Universal }
enum E_DamageCategory { Universal, Magical, Physical }
enum E_AttackType { Spell, Normal, Pierce, Siege, Magic, Chaos, Hero }
enum E_CostDisplay { Minerals, Vespene, Terrazine, Custom, Life, Shields, Energy }
enum E_EffectMissileSearch { DynamicSearchArea, ArriveOnSearchHit }
enum E_AbilArmMagazineEffect { Create, Death, Launch, Recall, Release, Retarget, Return } // editor strings e_abilArmMagEffect*; numeric order not verified against Galaxy
enum E_ConversationProductionLevelFlag { Locked }
enum E_ArmorType { Small, Medium, Large, Fort, Normal, Hero, Divine, None }
enum E_DamageKind { Spell, Melee, Ranged, Splash, NoProc }
enum E_DeathType { Normal, Remove, Blast, Disintegrate, Eat, Electrocute, Eviscerate, Fire, Freeze, Impact, Morph, Reincarnation, Silentkill, Squish, Timeout, Unlink, UnderConstruction, Salvage, Cancel, TrainingComplete, TrainingCancel }
enum E_CooldownOperation { Default, Add, Multiply, Min, Max, Set }
enum E_ResourceType { Minerals, Vespene, Terrazine, Custom }
enum E_EffectLocation { CasterUnit, CasterPoint, CasterUnitOrPoint, CasterOuterUnit, CasterOuterPoint, CasterOuterUnitOrPoint, SourceUnit, SourcePoint, SourceUnitOrPoint, OuterUnit, OuterPoint, OuterUnitOrPoint, TargetUnit, TargetPoint, TargetUnitOrPoint, TargetOuterUnit, TargetOuterPoint, TargetOuterUnitOrPoint, OriginUnit, OriginPoint, OriginUnitOrPoint }
enum E_EffectPlayer { Origin, Creator, Caster, CasterOuter, Outer, Source, Target, TargetOuter, Neutral, Hostile }
enum E_EffectUnit { Caster, CasterOuter, Outer, Source, Target, TargetOuter, Origin }
enum E_TeamColor { Diffuse, Emissive, Selected, Attacked }
enum E_TechCategory { Unit, Tech, Abil, Beha, Efct, Powr }
enum E_ValueCompare { Eq, NE, LT, GT, LE, GE }
enum E_Beacon { Army, Defend, Attack, Harass, Idle, Auto, Detect, Scout, Claim, Expand, Rally, Custom1, Custom2, Custom3, Custom4 }
enum E_CustomBuildOpening { Invalid, One, Two, Three, Four, Five }
enum E_CustomBuildLateGame { Invalid, One, Two, Three, Four, Five }
enum E_UnitTaunt { Cheer, Dance, Tease }
enum E_EffectAmount { Absorbed, Damaged, Dodged, Found, Healed, Killed, Splashed, LifeChanged, ShieldsChanged, EnergyChanged, LifeLeeched, ShieldsLeeched, EnergyLeeched, LifeGained, ShieldsGained, EnergyGained, DamageInherited }
enum E_EffectHistory { Damage, Death, Healing, Modifier }
enum E_UnitColorStyle { Normal, OverrideMinimap, OverrideWorld }
enum E_Hotkey { FPS, Music, Sound, PTT, DisplayMode, ChatAll, ChatAllies, ChatCancel, ChatDefault, ChatIndividual, ChatRecipient, ChatSend, DialogDismiss, MenuAchievements, MenuGame, MenuMessages, MenuHelp, MenuSocial, LeaderNone, LeaderResources, LeaderIncome, LeaderSpending, LeaderUnits, LeaderStructures, LeaderUnitsLost, LeaderProduction, LeaderUpgrades, LeaderArmy, LeaderAPM, LeaderCPM, ObserveAllPlayers, ObserveAutoCamera, ObserveClearSelection, ObserveCommentator, ObservePlayer0, ObservePlayer1, ObservePlayer2, ObservePlayer3, ObservePlayer4, ObservePlayer5, ObservePlayer6, ObservePlayer7, ObservePlayer8, ObservePlayer9, ObservePlayer10, ObservePlayer11, ObservePlayer12, ObservePlayer13, ObservePlayer14, ObservePlayer15, ObservePreview, ObserveSelected, ObserveStatusBars, ObserveZoomCameraLevel1, ObserveZoomCameraLevel2, NamePanel, StatPanelResources, StatPanelArmySupply, StatPanelUnitsLost, StatPanelAPM, StatPanelCPM, ToggleVersusModeSides, ToggleWorldPanel, ConversationSkipOne, CinematicSkip, AICommunication, AIArmy, AIScout, AIDetect, AIExpand, AIBuild, AIClearAll, AIDelete, AIExit, AICancel, AlertRecall, ArmySelect, CameraCenter, CameraFollow, CameraMoveUp, CameraMoveDown, CameraMoveLeft, CameraMoveRight, CameraTurnLeft, CameraTurnRight, CameraZoomFirst, CameraZoomLast, CameraZoomNext, CameraZoomPrev, CameraPush, CommanderAbility0, CommanderAbility1, CommanderAbility2, CommanderAbility3, ControlGroupAppend0, ControlGroupAppend1, ControlGroupAppend2, ControlGroupAppend3, ControlGroupAppend4, ControlGroupAppend5, ControlGroupAppend6, ControlGroupAppend7, ControlGroupAppend8, ControlGroupAppend9, ControlGroupAppendAndSteal0, ControlGroupAppendAndSteal1, ControlGroupAppendAndSteal2, ControlGroupAppendAndSteal3, ControlGroupAppendAndSteal4, ControlGroupAppendAndSteal5, ControlGroupAppendAndSteal6, ControlGroupAppendAndSteal7, ControlGroupAppendAndSteal8, ControlGroupAppendAndSteal9, ControlGroupAssign0, ControlGroupAssign1, ControlGroupAssign2, ControlGroupAssign3, ControlGroupAssign4, ControlGroupAssign5, ControlGroupAssign6, ControlGroupAssign7, ControlGroupAssign8, ControlGroupAssign9, ControlGroupAssignAndSteal0, ControlGroupAssignAndSteal1, ControlGroupAssignAndSteal2, ControlGroupAssignAndSteal3, ControlGroupAssignAndSteal4, ControlGroupAssignAndSteal5, ControlGroupAssignAndSteal6, ControlGroupAssignAndSteal7, ControlGroupAssignAndSteal8, ControlGroupAssignAndSteal9, ControlGroupRecall0, ControlGroupRecall1, ControlGroupRecall2, ControlGroupRecall3, ControlGroupRecall4, ControlGroupRecall5, ControlGroupRecall6, ControlGroupRecall7, ControlGroupRecall8, ControlGroupRecall9, GameSpeedDec, GameSpeedInc, GameTooltipsOn, HeroCharacterSheetPanel, HeroLeaderPanel, HeroSelect0, HeroSelect1, HeroSelect2, HeroSelect3, HeroSelect4, HeroSelect5, HeroSelect6, HeroSelect7, HeroTalentTreeSelection, IdleWorker, InventoryButtonAlt0, InventoryButtonAlt1, InventoryButtonAlt2, InventoryButtonAlt3, InventoryButtonAlt4, InventoryButtonAlt5, InventoryButtonAlt6, InventoryButtonAlt7, InventoryButtonUseSelf0, InventoryButtonUseSelf1, InventoryButtonUseSelf2, InventoryButtonUseSelf3, InventoryButtonUseSelf4, InventoryButtonUseSelf5, InventoryButtonUseSelf6, InventoryButtonUseSelf7, InventoryButtonUse0, InventoryButtonUse1, InventoryButtonUse2, InventoryButtonUse3, InventoryButtonUse4, InventoryButtonUse5, InventoryButtonUse6, InventoryButtonUse7, MinimapColors, MinimapPing, MinimapTargetingView, MinimapNormalView, MinimapTerrain, PauseGame, Ping, PingSelection0, PingSelection1, PingSelection2, PingSelection3, PingSelection4, PingSelection5, QuickPing, QuickSave, QuickHeroTalentTreeSelection, QuickHeroTalentTreeSelection0, QuickHeroTalentTreeSelection1, QuickHeroTalentTreeSelection2, QuickHeroTalentTreeSelection3, QuickHeroTalentTreeSelection4, EmoteMenu, ReplayPlayPause, ReplayRestart, ReplaySkipBack, ReplaySkipNext, ReplaySpeedDec, ReplaySpeedInc, ReplayStop, ReplayHide, Screenshot, SelectionCancelDrag, Selection, SmartCommand, Spotlight, StatusAll, StatusOwner, StatusAlly, StatusEnemy, SubgroupNext, SubgroupPrev, TargetCancel, TargetChoose, TeamResources, TownCamera, VideoRecord, WarpIn, CommandButtonAlt00, CommandButtonAlt01, CommandButtonAlt02, CommandButtonAlt03, CommandButtonAlt04, CommandButtonAlt05, CommandButtonAlt06, CommandButtonAlt07, CommandButtonAlt08, CommandButtonAlt09, CommandButtonAlt10, CommandButtonAlt11, CommandButtonAlt12, CommandButtonAlt13, CommandButtonAlt14, CommandButtonSelf00, CommandButtonSelf01, CommandButtonSelf02, CommandButtonSelf03, CommandButtonSelf04, CommandButtonSelf05, CommandButtonSelf06, CommandButtonSelf07, CommandButtonSelf08, CommandButtonSelf09, CommandButtonSelf10, CommandButtonSelf11, CommandButtonSelf12, CommandButtonSelf13, CommandButtonSelf14, CommandButton00, CommandButton01, CommandButton02, CommandButton03, CommandButton04, CommandButton05, CommandButton06, CommandButton07, CommandButton08, CommandButton09, CommandButton10, CommandButton11, CommandButton12, CommandButton13, CommandButton14, CameraSave0, CameraSave1, CameraSave2, CameraSave3, CameraSave4, CameraSave5, CameraSave6, CameraSave7, CameraView0, CameraView1, CameraView2, CameraView3, CameraView4, CameraView5, CameraView6, CameraView7, UIEditorToggle, UIEditorReload, UIEditorSaveSelected, UIEditorSaveAll, UIEditorUndo, UIEditorRedo, UIEditorDeselect, UIEditorShowInfoTooltip, UIEditorToggleVisible, UIEditorHoverControls, UIEditorLockInfoTooltip, UIEditorOutlineAnchors, UIEditorIncreaseGridSpacing, UIEditorDecreaseGridSpacing, UIEditorToggleStateGroupOverlay, UIEditorBreakToDebugger, UIEditorSize720x406, UIEditorSize800x600, UIEditorSize1024x768, UIEditorSize1280x1024, UIEditorSize1280x960, UIEditorSize1280x720, UIEditorSize1680x1050, UIEditorSize1400x1050, UIEditorSize1920x1200, UIEditorSize1920x1080, UIEditorSize1600x1200, UIEditorSize2048x1536, UIEditorSize2560x1600, UIEditorSize2560x2048, UIEditorSize4096x2560, UIEditorSize4096x2304, UIEditorSize4096x3072 }
enum E_PathLocation { World, Minimap }
enum E_NydusLink { BreakingNews, PTRAvailable, AccountManagement, AccountPurchase, AccountTrialUpgrade, AccountNew, AccountTrial, SecurityPassword, Forum, Community, FeedHomepage, FeedHomepageBackground, FeedCommunity, FeedFeaturedMaps, FeedLiveEvent, Store, SecurityHelp, Support, OnlineGuide, Copyright, ParentalControls, Regions, CacheList, RefundPolicy, TermsOfService, TermsOfSale, RecruitFriend, LowVirtualMemory, StarterEdition, PremiumMap, StimpackInfo, MaintenanceInfo, ExternalLink, CCPA }
enum E_HeroState { Locked, Unlocked }
enum E_HeroAbilCategoryState { Locked, Unlocked }
enum E_HeroCutsceneSize { Small, Medium, Large }
enum E_HeroFlag { Flyer, Random, UsesMount, ExcludeFromMapIntro, GoodForModeA, GoodForModeB, AllowAIRandomSelection, ShowInStore }
enum E_HeroRole { Warrior, Damage, Support, Specialist }
enum E_HeroDifficulty { Easy, Medium, Hard, VeryHard }
enum E_HeroVO { AIAttack, AICaution, AIGoodJob, AIHeal, AIMercCapture, AIOnMyWay, AIRetreat, AIUhOh, Celebrate, Cheer, Comeback, EndEnemyKillSpree, GetHit, GetHitLarge, GetHitSmall, GlueExamineLocked, GlueExaminePurchased, GlueGift, GluePurchase, GlueTrial, GlueWaitLocked, GlueWaitPurchased, Goodbye, Healed, Hello, IntroAgree, IntroBoast, IntroQuestion, IntroResponse, KillGeneric, Laugh, No, PingAssistHero, PingAssistMe, PingAttackCore, PingAttackHere, PingAttackHero, PingAttackMercCamp, PingAttackTown, PingAttackWatchTower, PingDefendCore, PingDefendHere, PingDefendTown, PingDefendWatchTower, Pissed, Resurrected, Revive, Sorry, SpecChosen, TeamKilled, Thanks, UILockin, WellPlayed, WorthIt }
enum E_HeroGender { Male, Female }
enum E_HeroUniverse { StarCraft, Warcraft, Diablo, Heroes, Retro }
enum E_HeroAbilFlag { ShowInHeroSelect, UsesCharges, AffectedByCooldownReduction, AffectedByOverdrive, Heroic, Trait, MountReplacement, HideHotkey }
enum E_HeroImageFacing { Left, Right, Mid }
enum E_HeroAITalentBuildType { General, Damage, Tank, Support }
enum E_HeroAbilState { Locked, Unlocked, New }
enum E_HeroStatState { Downgrade, Unchanged, Upgrade }
enum E_GameTimeEvent { Dawn, Dusk }
enum E_TimeOfDayValue { Value, Hours, Minutes, Seconds }
enum E_MissionState { Locked, Unlocked, Hidden, Complete }
enum E_MapKind { Mission, Story, Upgrade }

enum E_MountFlag { FreePlay, IsVariation }
enum E_MountVO { Mounted, Dismounted, Looping, Moving, Stationary }
enum E_ObjectiveType { Optional, Primary }
enum E_ObjectiveReward { DNA, Infestation, Mutagen }
enum E_PingFlag { UseUnitTeamColor, UseUnitVisibility }
enum E_SoundCategory { Test, ME, Movie, TV, Dialogue, Mission, Music, Other, Ambient, SAmbient, Alert, Death, Ready, Spell, SpellOneshotImpact, SpellOneshotLaunch, Combat, Voice, Message, UI, UIMovie, Flames, Build, Gather, Doodad, SEmitters, SPieces, Foley, Movement, User1, User2, User3, User4, User5, User6, User7, User8, User9, User10, User11, User12, User13, User14, User15, User16, User17, User18, User19, User20, User21, User22, User23, User24, User25, User26, User27, User28, User29, User30, User31, User32, User33, User34, User35 }
enum E_SoundtrackCategory { Ambience, Music }
enum E_TalentModification { None, CooldownReduction, FlatModification, MultiplyLevelModification, StringReplacement, CatalogReplacement }
enum E_TalentProfileFlag { Hidden }
enum E_UnitFlag { Bounce, Turnable, Movable, Worker, CreateVisible, Unclickable, Uncommandable, Unhighlightable, Untooltipable, Unselectable, Untargetable, Uncursorable, Hero, HiddenCargoUI, IndividualSubgroups, NoDraw, PreventReveal, PreventDefeat, PreventDestroy, PenaltyRevealed, Uncloakable, Missile, Undetectable, Unradarable, UseLineOfSight, KillCredit, TownAlert, Invulnerable, Destructible, Cloaked, Buried, NoScore, IgnoreTerrainZInit, TurnBeforeMove, AlwaysThreatens, NoDeathEvent, NoPortraitTalk, TownCamera, AIThreatGround, AIThreatAir, AILifetime, AISplash, AIHighPrioTarget, AISplitter, AIDefense, AICaster, AISupport, AICantAddToWave, ShowResources, ArmorDisabledWhileConstructing, Pawnable, AIFleeDamageDisabled, AIPressForwardDisabled, AIObservatory, ForceCollisionCheck, AIChangeling, ShareControl, BuiltOnOptional, AcquireRally, AIAllowSuicideOverride, AIForceTactical, VisionTestCenterOnly, Unstoppable, AIPreferBurrow, ClearRallyOnDeath, ClearRallyOnTargetLost, SelectableWhileDead, TargetableWhileDead, IgnoreAttackAlert, PreferLastAttackTarget, ResumeLastMoveOrder, AIResourceBlocker, ArmySelect, Resistant, PlayerRevivable, AIMakeIgnore, AIPreplacedForceBully, StatTrackAbilities, StatTrackDamageDone, StatTrackDamageReceived, StatTrackCreation, CameraFollow, LeechBehaviorShieldDamage, TownStructureWall, TownStructureGate, TownStructureTownHall, TownStructureCannonTower, TownStructureMoonwell, TownStructureCore, HideFromHarvestingCount, TreatStructureAsUnitForSelection, NonBuildingUnit, NeverThink, GrantLevelKillXP, UseOuterRadius, FootprintAlwaysIgnoreHeight, FootprintPersistRotate }
enum E_UnitCollide { Land1, Land2, Land3, Land4, Land5, Land6, Land7, Land8, Land9, Land10, Land11, Land12, Land13, Land14, Land15, Land16, Air1, Air2, Air3, Air4, Air5, Air6, Air7, Air8, Air9, Air10, Air11, Air12, Air13, Air14, Air15, Air16 } // Flying3,Swarm,Flying2,Ground,ForceField,Locust,Small,Flying,Burrow,Structure,RoachBurrow,Phased,Colossus,Flying0,FlyingImmobile,FlyingEscorts,LocustForceField,Burrow3,Larva,Flying6,Flying5,CreepTumor,TinyCritter,DisruptorPhase}
enum E_UnitAttribute { Light, Armored, Biological, Mechanical, Robotic, Psionic, Massive, Structure, Hover, Heroic, Summoned, User1, MapBoss }
enum E_CmdFlags { Alternate, Queued, Preempt, SmartClick, SmartRally, Subgroup, SetAutoCast, SetAutoCastOn, User, DataA, DataB, AI, AIIgnoreOnFinish, IsOrder, Script, HomogenousInterruption, Minimap, Repeat, DispatchToOtherUnit, TargetSelf, Continuous, QuickCast, AutoQueued, AIHeroes, BuildOnSelf, ToSelection, AttackOnce }
enum E_UpgradeOperation { Add, Subtract, AddBaseMultiply, SubtractBaseMultiply, Multiply, Divide, Set }
enum E_UserType { AbilCmd, Actor, Color, Compare, Fixed, GameLink, Image, Int, Model, Movie, Sound, String, Text, Unit, Upgrade, User }
enum E_Chance { Move, Anim, Idle, Turn }
enum E_FootprintLayer { Check, Place, Pathing }
enum E_NodeArray { Use, Show }
enum E_Sound { Rerecord, HideSubtitle, Obsolete, UseDoppler, NeedsUpdate, NeedsTTS, VariationFallback, Temporary, Download, Wait, Purgable, Stream, Ignorable, Unpausable, ManualOverride, UniqueDupeInfo, AutoUnload, AllowDuckingInPlayDelay, AllowMultiNotifies, NeedsFXA, SuppressCategoryDucking }
enum E_Model { GrowBoundsByElements, ParticipatesInRagdollOnRagdollCollisions, Wait, DynamicZChanger, AOData, AutoUnload, EmbeddedSplatsRespectOpacity, CloakedDetectedIsFullyVisible, CloakedUndetectedIsHidden, VariationPreload, VariationFallback, ShowCreepEngulfmentEvenOnLow, AdjustTerrain, ForcePortraitModel, Ignorable, Download, Facial, FOW, IgnoreAspectRatioScale, PreventedWhenPhysicsPerformanceConstrained, RequiresPhysicsToOperate, TeenSafe, ForceTextureSearch, FreezeParticlesAndRibbonsOnAnimPause, PreventClothCollisionVolumeAutoAdd, PreventTextureAutoUpdate, PreventTextureFileTokenRecognition, TipabilityLevelOffWhenStationary }
enum E_RequirementNode { TechTreeCheat }
enum E_LightInfoParam { HDRExposure, HDRBloomThreshold, HDRAmbientMultiplier, HDRDiffuseMultiplier, HDRWhitePoint, HDRSpecMultiplier, HDREmisMultiplier, HDRGain, HDRScale, TerrainSpecularExp, TerrainHDRDiffuse, TerrainHDRSpecular, CreepSpecularExp, CreepHDRDiffuseMultiplier, CreepHDRSpecMultiplier, CreepHDREmisMultiplier, ColorizationInputHigh, ColorizationInputGamma, ColorizationOutputHigh, ColorizationBrightness, ColorizationContrast, ColorizationBlend, AOOcclusionRadius, AOFullOcclusion, AONoOcclusion, AOOcclusionPower, AODetailOcclusionRadius, AODetailNoOcclusion, AODetailOcclusionPower, ShadowPenumbraSize, ColorizationHue, ColorizationSaturation, ColorizationLightness, ColorizationInputLow, ColorizationOutputLow, AODetailFullOcclusion }
enum E_CameraScale { Normal, Follow }
enum E_DamageMap { None, Shield, Dirt, Rock, Snow, Sand, Water, Flesh, Metal }
enum E_ConversationLineObjects { Speaker, Listener, Camera }
enum E_Mount { FreePlay, IsVariation }
enum E_Ping { UseUnitTeamColor, UseUnitVisibility }
enum E_ResponseUnitBirthType { Trained, Built, Morphed, TriggerCreated, EffectCreated, CheatCreated }
enum E_TalentProfile { Hidden }
enum E_UnitUser { }
enum E_HeroAbil { ShowInHeroSelect, UsesCharges, AffectedByCooldownReduction, AffectedByOverdrive, Heroic, Trait, MountReplacement, HideHotkey }
enum E_SharedXPMaxCount { }
enum E_XPReceiveFraction { }
enum E_AbilRedirectTarget { }
enum E_SoundLocaleFlags { }
enum E_ReplacementLayers { AlphaMask, AlphaMask2 }
enum E_SoundData { ApplyCategoryDuckingGlobal, ApplyCategoryDuckingNonLocal, AudibleWhenFocusLost, PauseOnDisable }
enum E_AbilAttack { UpdateTarget }
enum E_AbilBattery { AutoCast, AutoCastOffOwnerLeave, AutoCastOn }
enum E_AbilPawn { BestUnit, Smart }
enum E_ActorModelMaterial { }
enum E_ActorFilterAtCreation { }
enum E_ActorVisibleToAtCreation { }
enum E_ActorFilterPlayers { }
enum E_ActorVisibleToPlayers { }
enum E_AccumulatorAttributePoints { UseBasePoints, UseMainAttribute }
enum E_ActorTextOptions { }
enum E_DeltaSumFlags { }
enum E_AttachMethodBestMatch { }
enum E_WeaponIndexEnableArray { }
enum E_WeaponIndexDisableArray { }
enum E_TeleportTrack { }
enum E_EffectRedirectMissile { OriginalValidation }
enum E_AbilFlags { }
enum E_EffectFlags { }
enum E_TauntDoesntStopUnit { }

enum E_PitchRoll { MAX }
enum E_AgainstCenter { AgainstCenter }
enum E_OverkillType { DamageOverInterval }
enum E_HostSiteOpsSetHost { Weapon }
enum E_ActorClassFilter { Snapshot, Unit, Missile }
enum E_ActorTableKey { BasicAir, Basic }

enum E_AnimBracketState { AfterClosing }
enum E_AnimDone { Complete }
enum E_ConfirmationEvent { }
enum E_TeamId { Warp, Out, End }
enum E_Letter { A, B, C, D, E, F, G, H, I, J, K, L, M, N, O, P, Q, R, S, T, U, V, W, X, Y, Z }
enum E_Digit { Zero, One, Two, Three, Four, Five, Six, Seven, Eight, Nine }
enum E_AnimName { VariationEnd, IGNORE, Default, Stand, Alternate, Attached, Attack, Back, Birth, Blast, Blink, Block, Build, Burrow, Channel, Cinematic, Cloak, Close, Click, Complex, Corrupted, Cover, Creep, Custom, Dance, Dead, Death, Defeat, Detect, Dialogue, Disintegrate, Dominant, Double, Down, Eat, Electrocute, End, Enemy, Equal, Eviscerate, Far, Fast, Fidget, Fire, Flail, Fling, Fly, Forward, Freeze, Gather, GLbirth, GLdeath, GLdead, GLstand, Glow, Hearth, Highlight, Hover, Hold, In, Inferior, Interact, Intro, Jump, Kill, Land, Large, Left, Level, Listen, Lighting, Load, Medium, Melee, Morph, Mount, NearImpact, Omni, Out, Penetrate, Pickup, Placement, Portrait, Pose, Range, Ready, Reload, Restart, Resurrect, Ride, Right, Run, Scared, Shield, Silentkill, Simple, Slow, Small, Spell, Squish, Standup, Start, Stun, Superior, Surf, Talk, Taunt, Teleport, Thrown, Turbo, Turn, Unburrow, Unload, Unpowered, Up, Victory, Walk, Work, Wounded, Angry, Happy, Sad, AngryEyes, ClosedEyes, FearEyes, HappyEyes, NeutralEyes, SadEyes, SeriousEyes, SurpriseEyes, Arm, Chest, Eye, Leg, Adjutant, Dehaka, Evomaster, Horner, Kerrigan, Lasarra, Raynor, Stukov, Valerian, Zagara, Protoss, Terran, Zerg, Alternateex, Berserk, Bone, Chain, Combat, Complete, Critical, Decay, Defend, Devour, Dissipate, Drain, EatTree, Entangle, Fill, Flesh, Gold, Hit, Light, Lightning, Looping, Lumber, Moderate, Monkey, Off, Puke, Severe, Slam, Sleep, Spiked, Spin, StageFirst, StageSecond, StageThird, StageFourth, StageFifth, Swim, Throw, Upgrade, Ridebeast, Ridebike, Ridenone, Ridesurf }
enum E_PhysicsImpact { OnLand }
enum E_PhysiqsMaterialCompare { SofterOrEqual }
enum E_AIUIMode { Selectable, Hidden, Visible }
enum E_AnimBracketExitReason { ModelSwap }
enum E_GameEvent { Sync }
enum E_GameSpeed { Fast, Faster }
enum E_Status { Dead }
enum E_Scope { Unit }
enum E_OptionPhysics { Low }
enum E_FlyerHelper { All }
enum E_Movement { Below }
enum E_AbilEvent { }
enum E_AbilChargeEvent { }
enum E_AbilCooldownEvent { }
enum E_AbilMorphEvent { }
enum E_AbilRallyEvent { }
enum E_AbilTrainEvent { }
enum E_AbilTransportEvent { }
enum E_BehaviorStackItemEvent { }
enum E_BehaviorEvent { }
enum E_HerdLevelEvent { }
enum E_HerdSpeedEvent { }
enum E_TurretTargetEvent { }
enum E_UpgradeEvent { }
enum E_UnitTauntEvent { }
enum E_UnitRegenEvent { }
enum E_UnitRefundEvent { }
enum E_UnitPortraitEvent { }
enum E_UnitPointsEvent { }
enum E_UnitMovementUpdateEvent { }
enum E_UnitHighlightLocalEvent { }
enum E_UnitHeightUpdateEvent { }
enum E_UnitDetectedByViewerEvent { }
enum E_WeaponCriticalUpdateEvent { }
enum E_WeaponStartEvent { }
enum E_WeaponStopEvent { }
enum E_UnitConstructionEvent { }
enum E_UnitBlipUpdateEvent { }
enum E_AttachmentKey { Top, Bottom, Right, Left, Front, Rear }

enum E_SubName { Gone }
enum E_Signal { DestroyFlag }
enum E_RegionSubject { RemovedLast }
enum E_Selection { Add }
enum E_BuildCoachHoverEvent { Off }
enum E_ButtonHoverEvent { Off }
enum E_CursorUpdateEvent { Stop }
enum E_EffectEvent { Stop }
enum E_PhysicsImpactEvent { TurretImpact }
enum E_CutsceneEvent { Stop }

const Digit0030: string[] = Array.from({ length: 30 }, (_, i) => i.toString().padStart(2, "0"))
const Digit0099: string[] = Array.from({ length: 100 }, (_, i) => i.toString().padStart(2, "0"))
const Digit015: string[] = Array.from({ length: 100 }, (_, i) => i.toString())

//more 'group' links than enums. custom ids possible 
enum E_AbilityorEffectType { Item, Hero, Heroes, Unit, Structures, Units, MorphsandBurrows }
enum E_DoodadType { CliffRamps, Environment, Debris, Structures, Blocker, TerrainObject, NotDoodad, Track, Props }
enum E_Climate { Jungle, Urban, SpacePlatform, Installation, Volcanic, Wasteland, Lunar, Cave, InteriorInstallation, Ice, Desert }
enum E_ObjectType { Prop, Set, Structure, Spray, Decal, Unit, Resource, Other, Spell, Hero, Destructible, Item, PropStory, CharacterStory, Campaign, SetStory, Projectile, Shape, Character }
enum E_ObjectFamily { Campaign, Melee, FactionInfested, FactionTaldarim, FactionPrimal, FactionNerazim, FactionKhalai, FactionEvolved, FactionCovertOps, FactionPurifier, FactionRaider, FactionMarauder, Storymode, FactionOutlaw, FactionXelNaga, FactionMecha, Destructible }
enum E_ConversationType { Prerendered, Fidget, Gossip, Conversation, TVReports, ScriptedScenes, Installer, Pitch, Debrief, CutScene, UnitVO, Briefing, Generic, Ambient, Mission }
enum E_DataFamily { Melee, Campaign, Coop }
enum E_DataGroup { LoadOut, Ability, Unit, Weapon, Research, Structure, Buff, Mechanic, AbilityBuildTrain, Template }
enum E_FootprintGroup { Generic, 'Blight Buildings', SpecificDoodads, Specific, SpecificOthers }
enum E_LightGroup { Tilesets, UI, PortraitsUnitsTerran, PortraitsUnitsProtoss, PortraitsUnitsZerg, PortraitsUnitsCritter, PortraitsUnits, PortraitsBuildingsZerg, C3UI, C4UI, C3PortraitsUnitsTerran, C3PortraitsUnitsZerg, C3PortraitsUnitsProtoss, StoryModeCutScenesProtoss, C4PortraitsBuildingsZerg, C4PortraitsBuildingsTerran, C4PortraitsBuildingsProtoss, C4PortraitsUnitsProtoss, C4PortraitsUnitsZerg, C4PortraitsUnitsTerran, C5UI, C5PortraitsUnitsTerran, C5PortraitsUnitsZerg, C5PortraitsUnitsProtoss, C6PortraitsBuildingsZerg, C6PortraitsBuildingsTerran, C6PortraitsBuildingsProtoss, PortraitsBuildingsProtoss, PortraitsBuildingsTerran, StoryModeSetsZerg, StoryModeSetsProtoss, PortraitsUnitsOther, PortraitsUnitsXelnaga, Miscellaneous, StoryMode, CinematicsTerran, Cinematics, PortraitsUnitsVoid, StoryModeCutScenesZerg, CinematicsZerg }
enum E_TechType { Ability, Unit, Upgrade }
enum E_TerrainObjectType { HybridLabXelNaga }
enum E_UpgradeType { ArmorBonus, AttackBonus, Talents, SpellResearch, Melee, Ranged, Talent, Armor, Caster }


enum E_GameCatalog { Abil, Accumulator, Achievement, AchievementTerm, Actor, ActorSupport, Alert, ArmyCategory, ArmyUnit, ArmyUpgrade, Artifact, ArtifactSlot, AttachMethod, BankCondition, Beam, Behavior, Boost, Bundle, Button, Camera, Campaign, Character, Cliff, CliffMesh, ColorStyle, Commander, Config, ConsoleSkin, Conversation, ConversationState, Cursor, DataCollection, DataCollectionPattern, DecalPack, DSP, Effect, Emoticon, EmoticonPack, Footprint, FoW, Game, GameUI, Herd, HerdNode, Hero, HeroAbil, HeroStat, Item, ItemClass, ItemContainer, Kinetic, LensFlareSet, Light, Location, Loot, Map, Model, Mount, Mover, Objective, PhysicsMaterial, Ping, PlayerResponse, PortraitPack, Preload, PremiumMap, Race, RaceBannerPack, Requirement, RequirementNode, Reverb, Reward, ScoreResult, ScoreValue, Shape, Skin, SkinPack, Sound, SoundExclusivity, SoundMixSnapshot, Soundtrack, Spray, SprayPack, StimPack, TacCooldown, Tactical, Talent, TalentProfile, TargetFind, TargetSort, Terrain, TerrainObject, CliffDoodad, TerrainTex, Texture, TextureSheet, Tile, Trophy, Turret, Unit, Upgrade, User, Validator, VoiceOver, VoicePack, WarChest, WarChestSeason, Water, Weapon }

const E_ClassId = {
  ...E_ClassIdCAbil,
  ...E_ClassIdCAccumulator,
  ...E_ClassIdCAchievement,
  ...E_ClassIdCAchievementTerm,
  ...E_ClassIdCActor,
  ...E_ClassIdCAlert,
  ...E_ClassIdCArmyCategory,
  ...E_ClassIdCArmyUnit,
  ...E_ClassIdCArmyUpgrade,
  ...E_ClassIdCArtifact,
  ...E_ClassIdCArtifactSlot,
  ...E_ClassIdCAttachMethod,
  ...E_ClassIdCBankCondition,
  ...E_ClassIdCBeam,
  ...E_ClassIdCBehavior,
  ...E_ClassIdCBoost,
  ...E_ClassIdCBundle,
  ...E_ClassIdCButton,
  ...E_ClassIdCCamera,
  ...E_ClassIdCCampaign,
  ...E_ClassIdCCharacter,
  ...E_ClassIdCCliff,
  ...E_ClassIdCCliffMesh,
  ...E_ClassIdCColorStyle,
  ...E_ClassIdCCommander,
  ...E_ClassIdCConfig,
  ...E_ClassIdCConsoleSkin,
  ...E_ClassIdCConversation,
  ...E_ClassIdCConversationState,
  ...E_ClassIdCCursor,
  ...E_ClassIdCDataCollection,
  ...E_ClassIdCDataCollectionPattern,
  ...E_ClassIdCDecalPack,
  ...E_ClassIdCDSP,
  ...E_ClassIdCEffect,
  ...E_ClassIdCEmoticon,
  ...E_ClassIdCEmoticonPack,
  ...E_ClassIdCFootprint,
  ...E_ClassIdCFoW,
  ...E_ClassIdCGame,
  ...E_ClassIdCGameUI,
  ...E_ClassIdCHerd,
  ...E_ClassIdCHerdNode,
  ...E_ClassIdCHero,
  ...E_ClassIdCHeroAbil,
  ...E_ClassIdCHeroStat,
  ...E_ClassIdCItem,
  ...E_ClassIdCItemClass,
  ...E_ClassIdCItemContainer,
  ...E_ClassIdCKinetic,
  ...E_ClassIdCLensFlareSet,
  ...E_ClassIdCLight,
  ...E_ClassIdCLocation,
  ...E_ClassIdCLoot,
  ...E_ClassIdCMap,
  ...E_ClassIdCModel,
  ...E_ClassIdCMount,
  ...E_ClassIdCMover,
  ...E_ClassIdCObjective,
  ...E_ClassIdCPhysicsMaterial,
  ...E_ClassIdCPing,
  ...E_ClassIdCPlayerResponse,
  ...E_ClassIdCPortraitPack,
  ...E_ClassIdCPreload,
  ...E_ClassIdCPremiumMap,
  ...E_ClassIdCRace,
  ...E_ClassIdCRaceBannerPack,
  ...E_ClassIdCRequirement,
  ...E_ClassIdCRequirementNode,
  ...E_ClassIdCReverb,
  ...E_ClassIdCReward,
  ...E_ClassIdCScoreResult,
  ...E_ClassIdCScoreValue,
  ...E_ClassIdCShape,
  ...E_ClassIdCSkin,
  ...E_ClassIdCSkinPack,
  ...E_ClassIdCSound,
  ...E_ClassIdCSoundExclusivity,
  ...E_ClassIdCSoundMixSnapshot,
  ...E_ClassIdCSoundtrack,
  ...E_ClassIdCSpray,
  ...E_ClassIdCSprayPack,
  ...E_ClassIdCStimPack,
  ...E_ClassIdCTacCooldown,
  ...E_ClassIdCTactical,
  ...E_ClassIdCTalent,
  ...E_ClassIdCTalentProfile,
  ...E_ClassIdCTargetFind,
  ...E_ClassIdCTargetSort,
  ...E_ClassIdCTerrain,
  ...E_ClassIdCTerrainObject,
  ...E_ClassIdCCliffDoodad,
  ...E_ClassIdCTerrainTex,
  ...E_ClassIdCTexture,
  ...E_ClassIdCTextureSheet,
  ...E_ClassIdCTile,
  ...E_ClassIdCTrophy,
  ...E_ClassIdCTurret,
  ...E_ClassIdCUnit,
  ...E_ClassIdCUpgrade,
  ...E_ClassIdCUser,
  ...E_ClassIdCValidator,
  ...E_ClassIdCVoiceOver,
  ...E_ClassIdCVoicePack,
  ...E_ClassIdCWarChest,
  ...E_ClassIdCWarChestSeason,
  ...E_ClassIdCWater,
  ...E_ClassIdCWeapon
}
enum E_StructId {
  SGameContentCreationData, SProductReleaseDate, SAbilOrderDisplay, SEffectBehavior, SCooldown, SCharge, SCost, SCostFactor, STargetSorts, SMarker, SAbilTargetCursorInfo, SAbilCmdButton, SAbilArmMagazineInfo, SAbilBuildInfo, SAbilInventoryInfo, SAbilLearnInfo, SAbilMergeInfo, SAbilMorphSection, SAbilMorphInfo, SAbilPawnInfo, SAbilRallyInfo, SAbilResearchInfo, SAbilReviveCmdButton, SAbilReviveInfo, SAbilReviveInfoMax, SAbilSpecializeInfo, SAbilTrainInfo, SAbilWarpTrainInfo, SEffectWhichUnit, SEffectWhichLocation, SEffectWhichBehavior, SAccumulatorSwitchCase, SAccumulatedFixed, SAccumulatedUInt32, SAccumulatedGameRate, SAccumulatedGameTime, SEffectWhichPlayer, SAchievementTag, SActorRequest, SActorVisibilityShape, SActorEvent, SActorSiteOpsData, SActorModelAspect, SActorModelAspectSet, SAttachQuery, SActorHostedAttach, SEventDataFootprint, SEventDataSound, SActorPhysicsImpactData, SActorRangeAbil, SActorQuadDecoration, SActorSoundLayer, SActorAVPair, SActorActionTerrainSquib, SActorAVCluster, SActorPhysicsData, SActorQuerySubject, SActorQueryResponse, SActorSendBasics, SActorQuerySubjectResponse, SActorDeathBodySquib, SActorCloakState, SActorCloakTransition, SActorCreepHeightClass, SActorCreepRate, SActorDeathData, SActorDeathDataCustom, SLookAtTypeInfo, SLookAtType, SSplatEmitterMaterialInfo, SSplatEmitterInitInfo, SActorOverrideBlendTime, SActorOverrideTransitionBlendTime, SActorOverrideModel, SActorProgressStage, SActorHostedDelta, SSerpentAggregate, SSerpentSegment, SActorStateInfo, SActorBaseline, SActorDeathDataCustomGroup, SActorUnitImpactSoundExtras, SDamagePastRemainingHealth, SDamageOverInterval, STerrainSquibVisual, STerrainSquib, SUnitAbilSound, SErrorOverride, SLayerIcon, SLayerIconVariation, SLayerIconShield, SLayerIconShieldVariation, SVitalColor, SIconVariation, SStatusColor, SStatusChargeData, SStatusHarvesterData, STextTagParameters, SUnitKillRank, SBankPath, SArtifactRank, SAttachKey, SDeathResponse, SAttributeChange, SDamageKind, SScoreValueUpdate, SUnitResourceRatio, SUnitWeaponData, SModification, SVeterancyLevel, SBehaviorFraction, SEffectWhichTimeScale, SBehaviorDuration, SDamageResponse, SVitalRegenVitalRemain, SAbilReplace, SAbilAdd, SPowerStage, SSpawnInfo, STooltipBlock, STooltipTimeAbilCmd, SButtonCardLayout, SCameraParam, SCameraZoom, SCameraSmooth, SMovieConfig, SCampaignData, SCharacterVariation, SUIColorEntry, SCommanderUnit, SCommanderTalentTree, SCommanderMasteryTalent, SCommanderAbil, SCommanderDifficultyLevel, SConsoleSkinModel, SConversationUserValue, SConversationCondition, SConversationProductionLevel, SConversationConditionSet, SConversationAction, SConversationActionSet, SConversationFacialAnim, SConversationLine, SConversationRunActions, SConversationWait, SConversationJump, SConversationChoice, SConversationGroup, SConversationComment, SConversationStateInfoText, SConversationStateInfoValue, SConversationStateInfoModel, SConversationStateInfoUpgrade, SConversationStateInfoAbilCmd, SConversationStateVariation, SConversationStateInfoIds, SConversationStateIndex, SDataCollectionRecord, SUpgradeInfoWeapon, SDataFieldsPattern, SDataTokensPattern, STextureSheetEntry, SEffectDamageArea, SEffectSearchRevealerParams, SEffectEnumArea, SEffectMover, SEffectMissileBounce, SUpgradeEffect, SEffectUpgrade, SEffectModifyPlayerCost, SEffectModifyUnitCost, SEffectModifyWeapon, SEffectModifyVital, SEffectModifyTurret, SEffectSwitchCase, SEmoticonPackCampaign, SFootprintBitSet, SFootprintLayer, SFootprintShape, SDifficultyLevel, SAIBuild, SHandicap, SMapSize, SAspectMargin, STeamColor, SAIDescription, STriggerLib, STargetFilterResult, SBeaconInfo, SDamageTypeInfo, SAttackTypeInfo, SResourceConvert, SMeleePointThreshold, SChallenge, SChallengeCategory, SSoundQuality, SMinimapData, SSelectionData, SVolumeFade, SReverbRolloff, SVolumeThreshold, SVolumeRolloff, SSoundData, SMixRoute, SGlobalSoundData, SPointModel, SCameraShakeRotation, SCameraShakeFrequency, SCameraShakeAmplitude, SListenerRolloff, SUnitSpeedText, SWeaponSpeedText, SObjectGroupData, SLoadingScreenHelp, SLoadingBar, SGameModeInfo, SGameCategory, SDefaultGameVariant, STutorialConfig, SHotkeyInfo, SResourceUI, SHelpControlCategoryInfo, SHelpControlInfo, SHelpGameMechanicInfo, SAltSoundtrack, SCutsceneAssetPath, SHerdLevel, SHerdNode, SHeroAbilCategory, SHeroAbil, SHeroHeroicAbility, SHeroSpecificVO, SHeroTalentTree, SHeroTalentTier, SHeroSpecificIntroVO, SHeroLevelModification, SHeroLevelScaling, SHeroRatings, SHeroAITalentBuild, SHeroSpecificUI, SHeroStatModifier, SItemContainerSlot, SFlareInfo, STimeEvent, SDirectionalLight, SVariationConfig, SLightRegionInfo, SLightInfo, SMissionCategory, SLootChoice, SAnimFile, SAnimAlias, SAttachProps, SModelDataEvent, SPhysicsMaterialMapping, STextureNameAdaption, STextureDeclare, STextureInfo, STextureExpressionSpec, STextureMatchSpec, SModelVariation, SPathingData, SMotionOverlayPhase, SMotionPhase, SMotionOverlay, SStartingUnit, SUpkeepTax, SRequirementNode, SRequirementCount, SRewardCategory, SRewardSpecificUI, SGameReplacement, SSkinModelGroup, SSkinModelMacroRun, SSkinPackEntry, SSyncPointRange, SSoundAsset, SSoundAssetTemplate, SSoundLocaleFlags, SPitchShift, SReverbBalance, SSoundtrackMasterLayer, SSoundtrackSection, SSoundtrackSlaveLayer, SSoundtrackCue, STacAbilData, STalentRank, STalentModification, STalentAbilityModification, STargetFindEnumArea, SDSPArray, SCreepSettings, SFoliageSimulationConfig, STerrainDoodad, SFidget, SUnitArmorFormula, SStockCharge, SUnitAbilData, SUnitBehaviorData, SCardLayoutButton, SCardLayout, SAddedOnData, SUnitEquipment, SUnitReviveInfo, SAttributePointsInfo, SUpgradeEffectTemplate, SValidatorCondition, SValidatorFunction, SValidatorEnumArea, SVoiceOverSkin, SVoiceOverGroup, SVoiceOverLine, SVoicePackExampleLine, SUserInstanceField, SUserInstanceAbilCmd, SUserInstanceActor, SUserInstanceColor, SUserInstanceCompare, SUserInstanceFixed, SUserInstanceGameLink, SUserInstanceImage, SUserInstanceInt, SUserInstanceModel, SUserInstanceMovie, SUserInstanceSound, SUserInstanceString, SUserInstanceText, SUserInstanceUnit, SUserInstanceUpgrade, SUserInstanceUser, SUserField, SUserInstance, SWaterStateDesc, SWaterDoodad,
  SEditorCategories, SConst, SToken, STokenValue
}
enum E_TypeId {
  Int, Real, UReal, UInt, CString, Bit, Int8, Int16, Int32, UInt8, UInt16, UInt32, Real32, UReal32, CColor, CColorRGB, CColorHDR, TCargoSize, TCargoCapacity, TMarkerCount, TPreemptLevel, TAbilCmdIndex, TCliffLevel, TPowerLevel, TDifficultyLevel, TAIBuild, TPlayerId, TMountCategory, TAttackTargetPriority, TUnitRadius, TAttachPropIndex, TCommanderLevel, C3fVector, C2iVector, CScaleVector, C3Vector, C2Vector, C2fVector, C4Vector, THandicap, TCmdResult, TDifficulty, TSoundWeight, TSoundBalance, CFangleArc, CGameTime, CfRange, CFangle, CGamePoint, CQuad, CRange, CVariatorActorReal32, CEffectOffset, CRect, CfQuad, CVolumeRange, CVariatorActorAngle, CActorCreateKey, CActorLabelKey, CActorAngle, CAnimNameKey, CAnimProps, CFacing, CVariatorActorFangle, CFangleRate, CGameRate, CAttachKeys, CiRange, CiQuad, CGameSpeed, CVariatorGameFangle, CVariatorGameFixed, CStyleName, CPitchRange, CVolume, CGameAcceleration, CLabelExpression, CIdSetPlayers, CIdSetTeams, CSubNameKey, CGamePoInt3D, CMissileAcceleration, CMissileSpeed, CPhaseOutro, CThrowBand, CFangleRateMissile, CFangleAccelMissile, CPitch, CString4, CString32, CString50, CString80, Month, Day, Year, CFourCC, CCardId, CYawPitchRoll, CIdentifier, CCmdResult, TTriggerLibId, TCooldownLink, TChargeLink, TMarkerLink, TPowerLink, TProductHyperlinkId, THyperlinkId, TGalaxyFunction, TBattleProductId, TConversationItemId, TTechAlias, TBattleLicenseName, TUserFieldId, TUserInstanceId, TConversationStateOpId, TConversationStateIndexId, TConversationStateVariation, TConversationTag, TConversationStateInfoId, TUpgradeEffectValue, TVoiceOverSkinId, TVoiceOverGroupId, TLocaleId, CAbilSetId, TFootprintOffsets, TFootprintBorders, CTexturePath, CImagePath, CAssetFile, CImageLink, CMovieFile, CMapFile, CModelFile, CCutsceneFile, CFontStyleFile, CLayoutFile, CSoundFile, CAnimsFile, CFacialFile, CSyncModelDataFile, CXMLFile, CFontFile,
  TEditorCategories
}

type CLASSNAME = keyof typeof E_ClassId
type NAMESPACE = keyof typeof E_GameCatalog

// #endregion
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// #region Enum Classes
export class EGameCatalog extends CEnum.Ex(E_GameCatalog) { }
export class EStructId extends CEnum.Ex(E_StructId) { }
export class ETypeId extends CEnum.Ex(E_TypeId) { }
export class EClassId extends CEnum.Ex(E_ClassId) { }
// Sentinel from editor strings e_classIdCAbilUnknown ("None").
export class EClassIdCAbil extends CEnum.Ex(E_ClassIdCAbil) { static unknown = 'CAbilUnknown'; override unknown = 'CAbilUnknown' }
export class EClassIdCAccumulator extends CEnum.Ex(E_ClassIdCAccumulator) { }
export class EClassIdCAchievement extends CEnum.Ex(E_ClassIdCAchievement) { }
export class EClassIdCAchievementTerm extends CEnum.Ex(E_ClassIdCAchievementTerm) { }
export class EClassIdCActor extends CEnum.Ex(E_ClassIdCActor) { }
export class EClassIdCAlert extends CEnum.Ex(E_ClassIdCAlert) { }
export class EClassIdCArmyCategory extends CEnum.Ex(E_ClassIdCArmyCategory) { }
export class EClassIdCArmyUnit extends CEnum.Ex(E_ClassIdCArmyUnit) { }
export class EClassIdCArmyUpgrade extends CEnum.Ex(E_ClassIdCArmyUpgrade) { }
export class EClassIdCArtifact extends CEnum.Ex(E_ClassIdCArtifact) { }
export class EClassIdCArtifactSlot extends CEnum.Ex(E_ClassIdCArtifactSlot) { }
export class EClassIdCAttachMethod extends CEnum.Ex(E_ClassIdCAttachMethod) { }
export class EClassIdCBankCondition extends CEnum.Ex(E_ClassIdCBankCondition) { }
export class EClassIdCBeam extends CEnum.Ex(E_ClassIdCBeam) { }
// Sentinel from editor strings e_classIdCBehaviorUnknown ("None").
export class EClassIdCBehavior extends CEnum.Ex(E_ClassIdCBehavior) { static unknown = 'CBehaviorUnknown'; override unknown = 'CBehaviorUnknown' }
export class EClassIdCBoost extends CEnum.Ex(E_ClassIdCBoost) { }
export class EClassIdCBundle extends CEnum.Ex(E_ClassIdCBundle) { }
export class EClassIdCButton extends CEnum.Ex(E_ClassIdCButton) { }
export class EClassIdCCamera extends CEnum.Ex(E_ClassIdCCamera) { }
export class EClassIdCCampaign extends CEnum.Ex(E_ClassIdCCampaign) { }
export class EClassIdCCharacter extends CEnum.Ex(E_ClassIdCCharacter) { }
export class EClassIdCCliff extends CEnum.Ex(E_ClassIdCCliff) { }
export class EClassIdCCliffMesh extends CEnum.Ex(E_ClassIdCCliffMesh) { }
export class EClassIdCColorStyle extends CEnum.Ex(E_ClassIdCColorStyle) { }
export class EClassIdCCommander extends CEnum.Ex(E_ClassIdCCommander) { }
export class EClassIdCConfig extends CEnum.Ex(E_ClassIdCConfig) { }
export class EClassIdCConsoleSkin extends CEnum.Ex(E_ClassIdCConsoleSkin) { }
export class EClassIdCConversation extends CEnum.Ex(E_ClassIdCConversation) { }
export class EClassIdCConversationState extends CEnum.Ex(E_ClassIdCConversationState) { }
export class EClassIdCCursor extends CEnum.Ex(E_ClassIdCCursor) { }
export class EClassIdCDataCollection extends CEnum.Ex(E_ClassIdCDataCollection) { }
export class EClassIdCDataCollectionPattern extends CEnum.Ex(E_ClassIdCDataCollectionPattern) { }
export class EClassIdCDecalPack extends CEnum.Ex(E_ClassIdCDecalPack) { }
export class EClassIdCDSP extends CEnum.Ex(E_ClassIdCDSP) { }
export class EClassIdCEffect extends CEnum.Ex(E_ClassIdCEffect) { }
export class EClassIdCEmoticon extends CEnum.Ex(E_ClassIdCEmoticon) { }
export class EClassIdCEmoticonPack extends CEnum.Ex(E_ClassIdCEmoticonPack) { }
export class EClassIdCFootprint extends CEnum.Ex(E_ClassIdCFootprint) { }
export class EClassIdCFoW extends CEnum.Ex(E_ClassIdCFoW) { }
export class EClassIdCGame extends CEnum.Ex(E_ClassIdCGame) { }
export class EClassIdCGameUI extends CEnum.Ex(E_ClassIdCGameUI) { }
export class EClassIdCHerd extends CEnum.Ex(E_ClassIdCHerd) { }
export class EClassIdCHerdNode extends CEnum.Ex(E_ClassIdCHerdNode) { }
export class EClassIdCHero extends CEnum.Ex(E_ClassIdCHero) { }
export class EClassIdCHeroAbil extends CEnum.Ex(E_ClassIdCHeroAbil) { }
export class EClassIdCHeroStat extends CEnum.Ex(E_ClassIdCHeroStat) { }
export class EClassIdCItem extends CEnum.Ex(E_ClassIdCItem) { }
export class EClassIdCItemClass extends CEnum.Ex(E_ClassIdCItemClass) { }
export class EClassIdCItemContainer extends CEnum.Ex(E_ClassIdCItemContainer) { }
export class EClassIdCKinetic extends CEnum.Ex(E_ClassIdCKinetic) { }
export class EClassIdCLensFlareSet extends CEnum.Ex(E_ClassIdCLensFlareSet) { }
export class EClassIdCLight extends CEnum.Ex(E_ClassIdCLight) { }
export class EClassIdCLocation extends CEnum.Ex(E_ClassIdCLocation) { }
export class EClassIdCLoot extends CEnum.Ex(E_ClassIdCLoot) { }
export class EClassIdCMap extends CEnum.Ex(E_ClassIdCMap) { }
export class EClassIdCModel extends CEnum.Ex(E_ClassIdCModel) { }
export class EClassIdCMount extends CEnum.Ex(E_ClassIdCMount) { }
export class EClassIdCMover extends CEnum.Ex(E_ClassIdCMover) { }
export class EClassIdCObjective extends CEnum.Ex(E_ClassIdCObjective) { }
export class EClassIdCPhysicsMaterial extends CEnum.Ex(E_ClassIdCPhysicsMaterial) { }
export class EClassIdCPing extends CEnum.Ex(E_ClassIdCPing) { }
export class EClassIdCPlayerResponse extends CEnum.Ex(E_ClassIdCPlayerResponse) { }
export class EClassIdCPortraitPack extends CEnum.Ex(E_ClassIdCPortraitPack) { }
export class EClassIdCPreload extends CEnum.Ex(E_ClassIdCPreload) { }
export class EClassIdCPremiumMap extends CEnum.Ex(E_ClassIdCPremiumMap) { }
export class EClassIdCRace extends CEnum.Ex(E_ClassIdCRace) { }
export class EClassIdCRaceBannerPack extends CEnum.Ex(E_ClassIdCRaceBannerPack) { }
export class EClassIdCRequirement extends CEnum.Ex(E_ClassIdCRequirement) { }
export class EClassIdCRequirementNode extends CEnum.Ex(E_ClassIdCRequirementNode) { }
export class EClassIdCReverb extends CEnum.Ex(E_ClassIdCReverb) { }
export class EClassIdCReward extends CEnum.Ex(E_ClassIdCReward) { }
export class EClassIdCScoreResult extends CEnum.Ex(E_ClassIdCScoreResult) { }
export class EClassIdCScoreValue extends CEnum.Ex(E_ClassIdCScoreValue) { }
export class EClassIdCShape extends CEnum.Ex(E_ClassIdCShape) { }
export class EClassIdCSkin extends CEnum.Ex(E_ClassIdCSkin) { }
export class EClassIdCSkinPack extends CEnum.Ex(E_ClassIdCSkinPack) { }
export class EClassIdCSound extends CEnum.Ex(E_ClassIdCSound) { }
export class EClassIdCSoundExclusivity extends CEnum.Ex(E_ClassIdCSoundExclusivity) { }
export class EClassIdCSoundMixSnapshot extends CEnum.Ex(E_ClassIdCSoundMixSnapshot) { }
export class EClassIdCSoundtrack extends CEnum.Ex(E_ClassIdCSoundtrack) { }
export class EClassIdCSpray extends CEnum.Ex(E_ClassIdCSpray) { }
export class EClassIdCSprayPack extends CEnum.Ex(E_ClassIdCSprayPack) { }
export class EClassIdCStimPack extends CEnum.Ex(E_ClassIdCStimPack) { }
export class EClassIdCTacCooldown extends CEnum.Ex(E_ClassIdCTacCooldown) { }
export class EClassIdCTactical extends CEnum.Ex(E_ClassIdCTactical) { }
export class EClassIdCTalent extends CEnum.Ex(E_ClassIdCTalent) { }
export class EClassIdCTalentProfile extends CEnum.Ex(E_ClassIdCTalentProfile) { }
export class EClassIdCTargetFind extends CEnum.Ex(E_ClassIdCTargetFind) { }
export class EClassIdCTargetSort extends CEnum.Ex(E_ClassIdCTargetSort) { }
export class EClassIdCTerrain extends CEnum.Ex(E_ClassIdCTerrain) { }
export class EClassIdCTerrainObject extends CEnum.Ex(E_ClassIdCTerrainObject) { }
export class EClassIdCCliffDoodad extends CEnum.Ex(E_ClassIdCCliffDoodad) { }
export class EClassIdCTerrainTex extends CEnum.Ex(E_ClassIdCTerrainTex) { }
export class EClassIdCTexture extends CEnum.Ex(E_ClassIdCTexture) { }
export class EClassIdCTextureSheet extends CEnum.Ex(E_ClassIdCTextureSheet) { }
export class EClassIdCTile extends CEnum.Ex(E_ClassIdCTile) { }
export class EClassIdCTrophy extends CEnum.Ex(E_ClassIdCTrophy) { }
export class EClassIdCTurret extends CEnum.Ex(E_ClassIdCTurret) { }
export class EClassIdCUnit extends CEnum.Ex(E_ClassIdCUnit) { }
export class EClassIdCUpgrade extends CEnum.Ex(E_ClassIdCUpgrade) { }
export class EClassIdCUser extends CEnum.Ex(E_ClassIdCUser) { }
export class EClassIdCValidator extends CEnum.Ex(E_ClassIdCValidator) { }
export class EClassIdCVoiceOver extends CEnum.Ex(E_ClassIdCVoiceOver) { }
export class EClassIdCVoicePack extends CEnum.Ex(E_ClassIdCVoicePack) { }
export class EClassIdCWarChest extends CEnum.Ex(E_ClassIdCWarChest) { }
export class EClassIdCWarChestSeason extends CEnum.Ex(E_ClassIdCWarChestSeason) { }
export class EClassIdCWater extends CEnum.Ex(E_ClassIdCWater) { }
export class EClassIdCWeapon extends CEnum.Ex(E_ClassIdCWeapon) { }

export const NAMESPACE_CLASS_MAP: Record<string, string[]> = {
  Abil: Object.keys(E_ClassIdCAbil).filter(k => isNaN(Number(k))),
  Accumulator: Object.keys(E_ClassIdCAccumulator).filter(k => isNaN(Number(k))),
  Achievement: Object.keys(E_ClassIdCAchievement).filter(k => isNaN(Number(k))),
  AchievementTerm: Object.keys(E_ClassIdCAchievementTerm).filter(k => isNaN(Number(k))),
  Actor: Object.keys(E_ClassIdCActor).filter(k => isNaN(Number(k))),
  Alert: Object.keys(E_ClassIdCAlert).filter(k => isNaN(Number(k))),
  ArmyCategory: Object.keys(E_ClassIdCArmyCategory).filter(k => isNaN(Number(k))),
  ArmyUnit: Object.keys(E_ClassIdCArmyUnit).filter(k => isNaN(Number(k))),
  ArmyUpgrade: Object.keys(E_ClassIdCArmyUpgrade).filter(k => isNaN(Number(k))),
  Artifact: Object.keys(E_ClassIdCArtifact).filter(k => isNaN(Number(k))),
  ArtifactSlot: Object.keys(E_ClassIdCArtifactSlot).filter(k => isNaN(Number(k))),
  AttachMethod: Object.keys(E_ClassIdCAttachMethod).filter(k => isNaN(Number(k))),
  BankCondition: Object.keys(E_ClassIdCBankCondition).filter(k => isNaN(Number(k))),
  Beam: Object.keys(E_ClassIdCBeam).filter(k => isNaN(Number(k))),
  Behavior: Object.keys(E_ClassIdCBehavior).filter(k => isNaN(Number(k))),
  Boost: Object.keys(E_ClassIdCBoost).filter(k => isNaN(Number(k))),
  Bundle: Object.keys(E_ClassIdCBundle).filter(k => isNaN(Number(k))),
  Button: Object.keys(E_ClassIdCButton).filter(k => isNaN(Number(k))),
  Camera: Object.keys(E_ClassIdCCamera).filter(k => isNaN(Number(k))),
  Campaign: Object.keys(E_ClassIdCCampaign).filter(k => isNaN(Number(k))),
  Character: Object.keys(E_ClassIdCCharacter).filter(k => isNaN(Number(k))),
  Cliff: Object.keys(E_ClassIdCCliff).filter(k => isNaN(Number(k))),
  CliffMesh: Object.keys(E_ClassIdCCliffMesh).filter(k => isNaN(Number(k))),
  ColorStyle: Object.keys(E_ClassIdCColorStyle).filter(k => isNaN(Number(k))),
  Commander: Object.keys(E_ClassIdCCommander).filter(k => isNaN(Number(k))),
  Config: Object.keys(E_ClassIdCConfig).filter(k => isNaN(Number(k))),
  ConsoleSkin: Object.keys(E_ClassIdCConsoleSkin).filter(k => isNaN(Number(k))),
  Conversation: Object.keys(E_ClassIdCConversation).filter(k => isNaN(Number(k))),
  ConversationState: Object.keys(E_ClassIdCConversationState).filter(k => isNaN(Number(k))),
  Cursor: Object.keys(E_ClassIdCCursor).filter(k => isNaN(Number(k))),
  DataCollection: Object.keys(E_ClassIdCDataCollection).filter(k => isNaN(Number(k))),
  DataCollectionPattern: Object.keys(E_ClassIdCDataCollectionPattern).filter(k => isNaN(Number(k))),
  DecalPack: Object.keys(E_ClassIdCDecalPack).filter(k => isNaN(Number(k))),
  DSP: Object.keys(E_ClassIdCDSP).filter(k => isNaN(Number(k))),
  Effect: Object.keys(E_ClassIdCEffect).filter(k => isNaN(Number(k))),
  Emoticon: Object.keys(E_ClassIdCEmoticon).filter(k => isNaN(Number(k))),
  EmoticonPack: Object.keys(E_ClassIdCEmoticonPack).filter(k => isNaN(Number(k))),
  Footprint: Object.keys(E_ClassIdCFootprint).filter(k => isNaN(Number(k))),
  FoW: Object.keys(E_ClassIdCFoW).filter(k => isNaN(Number(k))),
  Game: Object.keys(E_ClassIdCGame).filter(k => isNaN(Number(k))),
  GameUI: Object.keys(E_ClassIdCGameUI).filter(k => isNaN(Number(k))),
  Herd: Object.keys(E_ClassIdCHerd).filter(k => isNaN(Number(k))),
  HerdNode: Object.keys(E_ClassIdCHerdNode).filter(k => isNaN(Number(k))),
  Hero: Object.keys(E_ClassIdCHero).filter(k => isNaN(Number(k))),
  HeroAbil: Object.keys(E_ClassIdCHeroAbil).filter(k => isNaN(Number(k))),
  HeroStat: Object.keys(E_ClassIdCHeroStat).filter(k => isNaN(Number(k))),
  Item: Object.keys(E_ClassIdCItem).filter(k => isNaN(Number(k))),
  ItemClass: Object.keys(E_ClassIdCItemClass).filter(k => isNaN(Number(k))),
  ItemContainer: Object.keys(E_ClassIdCItemContainer).filter(k => isNaN(Number(k))),
  Kinetic: Object.keys(E_ClassIdCKinetic).filter(k => isNaN(Number(k))),
  LensFlareSet: Object.keys(E_ClassIdCLensFlareSet).filter(k => isNaN(Number(k))),
  Light: Object.keys(E_ClassIdCLight).filter(k => isNaN(Number(k))),
  Location: Object.keys(E_ClassIdCLocation).filter(k => isNaN(Number(k))),
  Loot: Object.keys(E_ClassIdCLoot).filter(k => isNaN(Number(k))),
  Map: Object.keys(E_ClassIdCMap).filter(k => isNaN(Number(k))),
  Model: Object.keys(E_ClassIdCModel).filter(k => isNaN(Number(k))),
  Mount: Object.keys(E_ClassIdCMount).filter(k => isNaN(Number(k))),
  Mover: Object.keys(E_ClassIdCMover).filter(k => isNaN(Number(k))),
  Objective: Object.keys(E_ClassIdCObjective).filter(k => isNaN(Number(k))),
  PhysicsMaterial: Object.keys(E_ClassIdCPhysicsMaterial).filter(k => isNaN(Number(k))),
  Ping: Object.keys(E_ClassIdCPing).filter(k => isNaN(Number(k))),
  PlayerResponse: Object.keys(E_ClassIdCPlayerResponse).filter(k => isNaN(Number(k))),
  PortraitPack: Object.keys(E_ClassIdCPortraitPack).filter(k => isNaN(Number(k))),
  Preload: Object.keys(E_ClassIdCPreload).filter(k => isNaN(Number(k))),
  PremiumMap: Object.keys(E_ClassIdCPremiumMap).filter(k => isNaN(Number(k))),
  Race: Object.keys(E_ClassIdCRace).filter(k => isNaN(Number(k))),
  RaceBannerPack: Object.keys(E_ClassIdCRaceBannerPack).filter(k => isNaN(Number(k))),
  Requirement: Object.keys(E_ClassIdCRequirement).filter(k => isNaN(Number(k))),
  RequirementNode: Object.keys(E_ClassIdCRequirementNode).filter(k => isNaN(Number(k))),
  Reverb: Object.keys(E_ClassIdCReverb).filter(k => isNaN(Number(k))),
  Reward: Object.keys(E_ClassIdCReward).filter(k => isNaN(Number(k))),
  ScoreResult: Object.keys(E_ClassIdCScoreResult).filter(k => isNaN(Number(k))),
  ScoreValue: Object.keys(E_ClassIdCScoreValue).filter(k => isNaN(Number(k))),
  Shape: Object.keys(E_ClassIdCShape).filter(k => isNaN(Number(k))),
  Skin: Object.keys(E_ClassIdCSkin).filter(k => isNaN(Number(k))),
  SkinPack: Object.keys(E_ClassIdCSkinPack).filter(k => isNaN(Number(k))),
  Sound: Object.keys(E_ClassIdCSound).filter(k => isNaN(Number(k))),
  SoundExclusivity: Object.keys(E_ClassIdCSoundExclusivity).filter(k => isNaN(Number(k))),
  SoundMixSnapshot: Object.keys(E_ClassIdCSoundMixSnapshot).filter(k => isNaN(Number(k))),
  Soundtrack: Object.keys(E_ClassIdCSoundtrack).filter(k => isNaN(Number(k))),
  Spray: Object.keys(E_ClassIdCSpray).filter(k => isNaN(Number(k))),
  SprayPack: Object.keys(E_ClassIdCSprayPack).filter(k => isNaN(Number(k))),
  StimPack: Object.keys(E_ClassIdCStimPack).filter(k => isNaN(Number(k))),
  TacCooldown: Object.keys(E_ClassIdCTacCooldown).filter(k => isNaN(Number(k))),
  Tactical: Object.keys(E_ClassIdCTactical).filter(k => isNaN(Number(k))),
  Talent: Object.keys(E_ClassIdCTalent).filter(k => isNaN(Number(k))),
  TalentProfile: Object.keys(E_ClassIdCTalentProfile).filter(k => isNaN(Number(k))),
  TargetFind: Object.keys(E_ClassIdCTargetFind).filter(k => isNaN(Number(k))),
  TargetSort: Object.keys(E_ClassIdCTargetSort).filter(k => isNaN(Number(k))),
  Terrain: Object.keys(E_ClassIdCTerrain).filter(k => isNaN(Number(k))),
  TerrainObject: Object.keys(E_ClassIdCTerrainObject).filter(k => isNaN(Number(k))),
  CliffDoodad: Object.keys(E_ClassIdCCliffDoodad).filter(k => isNaN(Number(k))),
  TerrainTex: Object.keys(E_ClassIdCTerrainTex).filter(k => isNaN(Number(k))),
  Texture: Object.keys(E_ClassIdCTexture).filter(k => isNaN(Number(k))),
  TextureSheet: Object.keys(E_ClassIdCTextureSheet).filter(k => isNaN(Number(k))),
  Tile: Object.keys(E_ClassIdCTile).filter(k => isNaN(Number(k))),
  Trophy: Object.keys(E_ClassIdCTrophy).filter(k => isNaN(Number(k))),
  Turret: Object.keys(E_ClassIdCTurret).filter(k => isNaN(Number(k))),
  Unit: Object.keys(E_ClassIdCUnit).filter(k => isNaN(Number(k))),
  Upgrade: Object.keys(E_ClassIdCUpgrade).filter(k => isNaN(Number(k))),
  User: Object.keys(E_ClassIdCUser).filter(k => isNaN(Number(k))),
  Validator: Object.keys(E_ClassIdCValidator).filter(k => isNaN(Number(k))),
  VoiceOver: Object.keys(E_ClassIdCVoiceOver).filter(k => isNaN(Number(k))),
  VoicePack: Object.keys(E_ClassIdCVoicePack).filter(k => isNaN(Number(k))),
  WarChest: Object.keys(E_ClassIdCWarChest).filter(k => isNaN(Number(k))),
  WarChestSeason: Object.keys(E_ClassIdCWarChestSeason).filter(k => isNaN(Number(k))),
  Water: Object.keys(E_ClassIdCWater).filter(k => isNaN(Number(k))),
  Weapon: Object.keys(E_ClassIdCWeapon).filter(k => isNaN(Number(k))),
}

export class EPlayerTeam extends CEnum.Ex(E_PlayerTeam) { }
export class EColorEntry extends CEnum.Ex(E_ColorEntry) { }
export class EAbilCmdState extends CEnum.Ex(E_AbilCmdState) { }
export class ECooldownLocation extends CEnum.Ex(E_CooldownLocation) { }
export class EAbilAlignment extends CEnum.Ex(E_AbilAlignment) { }
export class EChargeLocation extends CEnum.Ex(E_ChargeLocation) { }
export class EAbilTechPlayer extends CEnum.Ex(E_AbilTechPlayer) { }
export class EFogVisibility extends CEnum.Ex(E_FogVisibility) { }
export class EAttachKeyword extends CEnum.Ex(E_AttachKeyword) { }
export class EActorScopeBearingsTrackingType extends CEnum.Ex(E_ActorScopeBearingsTrackingType) { }
export class EActorRequestScope extends CEnum.Ex(E_ActorRequestScope) { }
export class EActorRequestActor extends CEnum.Ex(E_ActorRequestActor) { }
export class EActorEffectScope extends CEnum.Ex(E_ActorEffectScope) { }
export class EActorShieldFlashType extends CEnum.Ex(E_ActorShieldFlashType) { }
export class ESplatLayer extends CEnum.Ex(E_SplatLayer) { }
export class ECmdResult extends CEnum.Ex(E_CmdResult) { }
export class EActorOverkillTestType extends CEnum.Ex(E_ActorOverkillTestType) { }
export class EActorSplatHeight extends CEnum.Ex(E_ActorSplatHeight) { }
export class EAMFilterLogic extends CEnum.Ex(E_AMFilterLogic) { }
export class EEffectTimeScale extends CEnum.Ex(E_EffectTimeScale) { }
export class EBehaviorAlignment extends CEnum.Ex(E_BehaviorAlignment) { }
export class EEffectLocationType extends CEnum.Ex(E_EffectLocationType) { }
export class EDamageVisibility extends CEnum.Ex(E_DamageVisibility) { }
export class EEffectModifyFacing extends CEnum.Ex(E_EffectModifyFacing) { }
export class EOcclusion extends CEnum.Ex(E_Occlusion) { }
export class EModelEvent extends CEnum.Ex(E_ModelEvent) { }
export class ESquibType extends CEnum.Ex(E_SquibType) { }
export class EMotionDriverType extends CEnum.Ex(E_MotionDriverType) { }
export class EMotionOverlayType extends CEnum.Ex(E_MotionOverlayType) { }
export class EMotionOverlayPolarity extends CEnum.Ex(E_MotionOverlayPolarity) { }
export class EMotionThrowRotationType extends CEnum.Ex(E_MotionThrowRotationType) { }
export class EMotionArrivalTestType extends CEnum.Ex(E_MotionArrivalTestType) { }
export class EMotionBlendType extends CEnum.Ex(E_MotionBlendType) { }
export class EMotionTurnType extends CEnum.Ex(E_MotionTurnType) { }
export class EMotionRotationActorType extends CEnum.Ex(E_MotionRotationActorType) { }
export class ESoundDupe extends CEnum.Ex(E_SoundDupe) { }
export class ESoundMode extends CEnum.Ex(E_SoundMode) { }
export class ESoundDupePriority extends CEnum.Ex(E_SoundDupePriority) { }
export class ESoundSelect extends CEnum.Ex(E_SoundSelect) { }
export class ETurretIdle extends CEnum.Ex(E_TurretIdle) { }
export class EUnitMob extends CEnum.Ex(E_UnitMob) { }
export class ECostCategory extends CEnum.Ex(E_CostCategory) { }
export class ECardButtonType extends CEnum.Ex(E_CardButtonType) { }
export class EAcquireLevel extends CEnum.Ex(E_AcquireLevel) { }
export class EUnitResponse extends CEnum.Ex(E_UnitResponse) { }
export class EUnitDisplay extends CEnum.Ex(E_UnitDisplay) { }
export class EDisplay extends CEnum.Ex(E_Display) { }
export class EValidateCombine extends CEnum.Ex(E_ValidateCombine) { }
export class EUnitType extends CEnum.Ex(E_UnitType) { }
export class EWeaponLegacyMovement extends CEnum.Ex(E_WeaponLegacyMovement) { }
export class EWeaponPrioritization extends CEnum.Ex(E_WeaponPrioritization) { }
export class EAbilArmMagazineManage extends CEnum.Ex(E_AbilArmMagazineManage) { }
export class EAbilOrderDisplayType extends CEnum.Ex(E_AbilOrderDisplayType) { }
export class EVitalsAccumulatorModificationType extends CEnum.Ex(E_VitalsAccumulatorModificationType) { }
export class EActorHostedPropInheritType extends CEnum.Ex(E_ActorHostedPropInheritType) { }
export class EUnitSound extends CEnum.Ex(E_UnitSound) { }
export class EAlertPeripheral extends CEnum.Ex(E_AlertPeripheral) { }
export class EBehaviorUnitTrackerAtMaxRule extends CEnum.Ex(E_BehaviorUnitTrackerAtMaxRule) { }
export class EListWalkMode extends CEnum.Ex(E_ListWalkMode) { }
export class EPathMode extends CEnum.Ex(E_PathMode) { }
export class EMotionActorTrackingType extends CEnum.Ex(E_MotionActorTrackingType) { }
export class EMotionRotationLaunchActorType extends CEnum.Ex(E_MotionRotationLaunchActorType) { }
export class ETargetFindSet extends CEnum.Ex(E_TargetFindSet) { }
export class EResourceState extends CEnum.Ex(E_ResourceState) { }
export class EScoreValue extends CEnum.Ex(E_ScoreValue) { }
export class EScoreValueFlags extends CEnum.Ex(E_ScoreValueFlags) { }
export class EVitalType extends CEnum.Ex(E_VitalType) { }
export class EUnitTestState extends CEnum.Ex(E_UnitTestState) { }
export class EActorForceField extends CEnum.Ex(E_ActorForceField) { }
export class EActorForceDirection extends CEnum.Ex(E_ActorForceDirection) { }
export class EEffectRemoveBehaviorAlignment extends CEnum.Ex(E_EffectRemoveBehaviorAlignment) { }
export class EEffectContainer extends CEnum.Ex(E_EffectContainer) { }
export class ECursorRangeMode extends CEnum.Ex(E_CursorRangeMode) { }
export class EAccumulatorOperation extends CEnum.Ex(E_AccumulatorOperation) { }
export class EAccumulatorApplicationRule extends CEnum.Ex(E_AccumulatorApplicationRule) { }
export class EActorTextAlignment extends CEnum.Ex(E_ActorTextAlignment) { }
export class ESoundBlend extends CEnum.Ex(E_SoundBlend) { }
export class ECargoSpace extends CEnum.Ex(E_CargoSpace) { }
export class EAMPatternType extends CEnum.Ex(E_AMPatternType) { }
export class EImplementionLevel extends CEnum.Ex(E_ImplementionLevel) { }
export class EVariationCommands extends CEnum.Ex(E_VariationCommands) { }
export class ETonemapRegionTypes extends CEnum.Ex(E_TonemapRegionTypes) { }
export class EPausedParticleSystemBehavior extends CEnum.Ex(E_PausedParticleSystemBehavior) { }
export class EActorSoundPlayMode extends CEnum.Ex(E_ActorSoundPlayMode) { }
export class ECharacterRace extends CEnum.Ex(E_CharacterRace) { }
export class EActorSoundValueSource extends CEnum.Ex(E_ActorSoundValueSource) { }
export class EUnitGender extends CEnum.Ex(E_UnitGender) { }
export class EAbilBuildType extends CEnum.Ex(E_AbilBuildType) { }
export class EAbilArmMagazineLaunch extends CEnum.Ex(E_AbilArmMagazineLaunch) { }
export class EActorCrossbarDistribution extends CEnum.Ex(E_ActorCrossbarDistribution) { }
export class EActorIncomingType extends CEnum.Ex(E_ActorIncomingType) { }
export class EActorRequestCreateSharing extends CEnum.Ex(E_ActorRequestCreateSharing) { }
export class EActorHeightSourceType extends CEnum.Ex(E_ActorHeightSourceType) { }
export class EActorHeightTestType extends CEnum.Ex(E_ActorHeightTestType) { }
export class EDamageResponseHandledValue extends CEnum.Ex(E_DamageResponseHandledValue) { }
export class EAccumulatorBehaviorType extends CEnum.Ex(E_AccumulatorBehaviorType) { }
export class EActorProximity extends CEnum.Ex(E_ActorProximity) { }
export class EActorSiteOrbiterType extends CEnum.Ex(E_ActorSiteOrbiterType) { }
export class EDamageResponseDamageValue extends CEnum.Ex(E_DamageResponseDamageValue) { }
export class EBehaviorBuffReplace extends CEnum.Ex(E_BehaviorBuffReplace) { }
export class EDamageTotal extends CEnum.Ex(E_DamageTotal) { }
export class EKineticFollow extends CEnum.Ex(E_KineticFollow) { }
export class EBehaviorState extends CEnum.Ex(E_BehaviorState) { }
export class EAbilReviveVital extends CEnum.Ex(E_AbilReviveVital) { }
export class EAMRandomDistribution extends CEnum.Ex(E_AMRandomDistribution) { }
export class EFootprintShapeMode extends CEnum.Ex(E_FootprintShapeMode) { }
export class EDeathReveal extends CEnum.Ex(E_DeathReveal) { }
export class EEditorTextType extends CEnum.Ex(E_EditorTextType) { }
export class EAchievementTagCheck extends CEnum.Ex(E_AchievementTagCheck) { }
export class EAchievementTermEvaluate extends CEnum.Ex(E_AchievementTermEvaluate) { }
export class EAchievementTermCombine extends CEnum.Ex(E_AchievementTermCombine) { }
export class EActorRadialDistribution extends CEnum.Ex(E_ActorRadialDistribution) { }
export class EActorResponseScope extends CEnum.Ex(E_ActorResponseScope) { }
export class EActorCombatRevealDurationType extends CEnum.Ex(E_ActorCombatRevealDurationType) { }
export class ECharacterGender extends CEnum.Ex(E_CharacterGender) { }
export class ECharacterRelevance extends CEnum.Ex(E_CharacterRelevance) { }
export class EMuteControl extends CEnum.Ex(E_MuteControl) { }
export class EVolumeControl extends CEnum.Ex(E_VolumeControl) { }
export class EGlueTheme extends CEnum.Ex(E_GlueTheme) { }
export class EScoreCollapse extends CEnum.Ex(E_ScoreCollapse) { }
export class EScoreSort extends CEnum.Ex(E_ScoreSort) { }
export class EScoreValueOperation extends CEnum.Ex(E_ScoreValueOperation) { }
export class EScoreValueReport extends CEnum.Ex(E_ScoreValueReport) { }
export class EScoreValueType extends CEnum.Ex(E_ScoreValueType) { }
export class EExclusivityAction extends CEnum.Ex(E_ExclusivityAction) { }
export class EExclusivityQueueAction extends CEnum.Ex(E_ExclusivityQueueAction) { }
export class EVoiceOverSoundType extends CEnum.Ex(E_VoiceOverSoundType) { }
export class EAbilMorphPhase extends CEnum.Ex(E_AbilMorphPhase) { }
export class EActorPhysicsImpactRangeType extends CEnum.Ex(E_ActorPhysicsImpactRangeType) { }
export class ESerpentType extends CEnum.Ex(E_SerpentType) { }
export class EActorSiteOpRotatorType extends CEnum.Ex(E_ActorSiteOpRotatorType) { }
export class EAbilMorphSection extends CEnum.Ex(E_AbilMorphSection) { }
export class EActorSiteOpActionLocation extends CEnum.Ex(E_ActorSiteOpActionLocation) { }
export class EActorSiteOpBasicType extends CEnum.Ex(E_ActorSiteOpBasicType) { }
export class EActorEffectLocation extends CEnum.Ex(E_ActorEffectLocation) { }
export class EAMAttachType extends CEnum.Ex(E_AMAttachType) { }
export class EAMOccupancyLogic extends CEnum.Ex(E_AMOccupancyLogic) { }
export class EAMArcTestType extends CEnum.Ex(E_AMArcTestType) { }
export class EAMFilterAttachType extends CEnum.Ex(E_AMFilterAttachType) { }
export class EAMFilterType extends CEnum.Ex(E_AMFilterType) { }
export class EAMReductionType extends CEnum.Ex(E_AMReductionType) { }
export class ECameraHeightMap extends CEnum.Ex(E_CameraHeightMap) { }
export class ESoundFormat extends CEnum.Ex(E_SoundFormat) { }
export class ESoundResampler extends CEnum.Ex(E_SoundResampler) { }
export class EUIColorRelation extends CEnum.Ex(E_UIColorRelation) { }
export class EGameCategoryUsage extends CEnum.Ex(E_GameCategoryUsage) { }
export class ETargetModeValidation extends CEnum.Ex(E_TargetModeValidation) { }
export class EWeaponType extends CEnum.Ex(E_WeaponType) { }
export class ESkillPoint extends CEnum.Ex(E_SkillPoint) { }
export class EUnitAIFlag extends CEnum.Ex(E_UnitAIFlag) { }
export class EPlayerRelationship extends CEnum.Ex(E_PlayerRelationship) { }
export class EAbilBehavior extends CEnum.Ex(E_AbilBehavior) { }
export class EAbilEffect extends CEnum.Ex(E_AbilEffect) { }
export class EProgressButtonArray extends CEnum.Ex(E_ProgressButtonArray) { }
export class ECancelEffect extends CEnum.Ex(E_CancelEffect) { }
export class EAbilityCategories extends CEnum.Ex(E_AbilityCategories) { }
export class EAbilBuild extends CEnum.Ex(E_AbilBuild) { }
export class EEffectArray extends CEnum.Ex(E_EffectArray) { }
export class EAbilTransport extends CEnum.Ex(E_AbilTransport) { }
export class EAbilMorph extends CEnum.Ex(E_AbilMorph) { }
export class ESectionArray extends CEnum.Ex(E_SectionArray) { }
export class EDurationArray extends CEnum.Ex(E_DurationArray) { }
export class EActorInherits extends CEnum.Ex(E_ActorInherits) { }
export class EActorTransfer extends CEnum.Ex(E_ActorTransfer) { }
export class EActorFlags extends CEnum.Ex(E_ActorFlags) { }
export class EImpactMap extends CEnum.Ex(E_ImpactMap) { }
export class EActorModel extends CEnum.Ex(E_ActorModel) { }
export class EActionFlags extends CEnum.Ex(E_ActionFlags) { }
export class EActorHostedPropTransfer extends CEnum.Ex(E_ActorHostedPropTransfer) { }
export class EDeathArray extends CEnum.Ex(E_DeathArray) { }
export class ESoundArray extends CEnum.Ex(E_SoundArray) { }
export class EUnitFlags extends CEnum.Ex(E_UnitFlags) { }
export class EActorFilter extends CEnum.Ex(E_ActorFilter) { }
export class EGroupSoundArray extends CEnum.Ex(E_GroupSoundArray) { }
export class EBaselines extends CEnum.Ex(E_Baselines) { }
export class EActorSquibMap extends CEnum.Ex(E_ActorSquibMap) { }
export class ERangeFlags extends CEnum.Ex(E_RangeFlags) { }
export class EInfoFlags extends CEnum.Ex(E_InfoFlags) { }
export class EDisplayDuration extends CEnum.Ex(E_DisplayDuration) { }
export class EBehaviorModify extends CEnum.Ex(E_BehaviorModify) { }
export class EBuffFlags extends CEnum.Ex(E_BuffFlags) { }
export class EBehaviorFlags extends CEnum.Ex(E_BehaviorFlags) { }
export class EHeightTime extends CEnum.Ex(E_HeightTime) { }
export class ETooltipFlags extends CEnum.Ex(E_TooltipFlags) { }
export class ESearchFlags extends CEnum.Ex(E_SearchFlags) { }
export class EResponse extends CEnum.Ex(E_Response) { }
export class EDamage extends CEnum.Ex(E_Damage) { }
export class ECreateFlags extends CEnum.Ex(E_CreateFlags) { }
export class EEffectCreatePersistent extends CEnum.Ex(E_EffectCreatePersistent) { }
export class ETeleportFlags extends CEnum.Ex(E_TeleportFlags) { }
export class EModifyFlags extends CEnum.Ex(E_ModifyFlags) { }
export class EEffectReveal extends CEnum.Ex(E_EffectReveal) { }
export class EEffectApplyBehavior extends CEnum.Ex(E_EffectApplyBehavior) { }
export class EEffectLaunchMissile extends CEnum.Ex(E_EffectLaunchMissile) { }
export class ENotifyArea extends CEnum.Ex(E_NotifyArea) { }
export class ECmd extends CEnum.Ex(E_Cmd) { }
export class EDirectionalLight extends CEnum.Ex(E_DirectionalLight) { }
export class ESAttachPropsKeys extends CEnum.Ex(E_SAttachPropsKeys) { }
export class ERace extends CEnum.Ex(E_Race) { }
export class EStartingUnit extends CEnum.Ex(E_StartingUnit) { }
export class ERequirement extends CEnum.Ex(E_Requirement) { }
export class EUpgrade extends CEnum.Ex(E_Upgrade) { }
export class EWeaponOptions extends CEnum.Ex(E_WeaponOptions) { }
export class EWeaponLegacyOptions extends CEnum.Ex(E_WeaponLegacyOptions) { }
export class EAbilAugment extends CEnum.Ex(E_AbilAugment) { }
export class EAbilShared extends CEnum.Ex(E_AbilShared) { }
export class EAbilArmMagazine extends CEnum.Ex(E_AbilArmMagazine) { }
export class EAbilArmMagazineInfo extends CEnum.Ex(E_AbilArmMagazineInfo) { }
export class ECharge extends CEnum.Ex(E_Charge) { }
export class ECliffLevelCompare extends CEnum.Ex(E_CliffLevelCompare) { }
export class ETerrainSquibVisual extends CEnum.Ex(E_TerrainSquibVisual) { }
export class EAlertFlags extends CEnum.Ex(E_AlertFlags) { }
export class EAlertDisplay extends CEnum.Ex(E_AlertDisplay) { }
export class EBehaviorPowerUser extends CEnum.Ex(E_BehaviorPowerUser) { }
export class EEffectCreateHealer extends CEnum.Ex(E_EffectCreateHealer) { }
export class EEffectModifyTurret extends CEnum.Ex(E_EffectModifyTurret) { }
export class ESelectionTransfer extends CEnum.Ex(E_SelectionTransfer) { }
export class ENegative extends CEnum.Ex(E_Negative) { }
export class EPositive extends CEnum.Ex(E_Positive) { }
export class EMover extends CEnum.Ex(E_Mover) { }
export class EAdaptableParabolaDistances extends CEnum.Ex(E_AdaptableParabolaDistances) { }
export class EAdaptableParabolaAccels extends CEnum.Ex(E_AdaptableParabolaAccels) { }
export class ETargetFind extends CEnum.Ex(E_TargetFind) { }
export class EEditor extends CEnum.Ex(E_Editor) { }
export class EAbilQueue extends CEnum.Ex(E_AbilQueue) { }
export class EAbilMerge extends CEnum.Ex(E_AbilMerge) { }
export class EAlertArray extends CEnum.Ex(E_AlertArray) { }
export class EForceFlags extends CEnum.Ex(E_ForceFlags) { }
export class ERateMultiplierArray extends CEnum.Ex(E_RateMultiplierArray) { }
export class ETexture extends CEnum.Ex(E_Texture) { }
export class EUnitTrackerFlags extends CEnum.Ex(E_UnitTrackerFlags) { }
export class EBehaviorResource extends CEnum.Ex(E_BehaviorResource) { }
export class EMorphFlags extends CEnum.Ex(E_MorphFlags) { }
export class EEffectCancelOrder extends CEnum.Ex(E_EffectCancelOrder) { }
export class EActorVisibleTo extends CEnum.Ex(E_ActorVisibleTo) { }
export class EEffectBehavior extends CEnum.Ex(E_EffectBehavior) { }
export class ECancelDelay extends CEnum.Ex(E_CancelDelay) { }
export class EAbilResearch extends CEnum.Ex(E_AbilResearch) { }
export class EAbilTrain extends CEnum.Ex(E_AbilTrain) { }
export class EAbilRedirectInstant extends CEnum.Ex(E_AbilRedirectInstant) { }
export class EAbilHarvest extends CEnum.Ex(E_AbilHarvest) { }
export class EUseBuildTimeArray extends CEnum.Ex(E_UseBuildTimeArray) { }
export class EShadowFlags extends CEnum.Ex(E_ShadowFlags) { }
export class EDamageResponseCategory extends CEnum.Ex(E_DamageResponseCategory) { }
export class EAttackTypeResponse extends CEnum.Ex(E_AttackTypeResponse) { }
export class EConjoinedFlags extends CEnum.Ex(E_ConjoinedFlags) { }
export class EInfoIds extends CEnum.Ex(E_InfoIds) { }
export class EEquipmentDisplay extends CEnum.Ex(E_EquipmentDisplay) { }
export class EDisplayShield extends CEnum.Ex(E_DisplayShield) { }
export class EReward extends CEnum.Ex(E_Reward) { }
export class EAbilSpecializeInfo extends CEnum.Ex(E_AbilSpecializeInfo) { }
export class EAbilTrainInfo extends CEnum.Ex(E_AbilTrainInfo) { }
export class EAbilWarpTrain extends CEnum.Ex(E_AbilWarpTrain) { }
export class EActorDoodad extends CEnum.Ex(E_ActorDoodad) { }
export class EActorPhysicsData extends CEnum.Ex(E_ActorPhysicsData) { }
export class ESoundFlags extends CEnum.Ex(E_SoundFlags) { }
export class EAlertPrimaryActions extends CEnum.Ex(E_AlertPrimaryActions) { }
export class EAlertSecondaryActions extends CEnum.Ex(E_AlertSecondaryActions) { }
export class EBehaviorSpawn extends CEnum.Ex(E_BehaviorSpawn) { }
export class EPlacementArray extends CEnum.Ex(E_PlacementArray) { }
export class EPathingDataBits extends CEnum.Ex(E_PathingDataBits) { }
export class EPathingType extends CEnum.Ex(E_PathingType) { }
export class EValidatorUnitCompareAttackPriority extends CEnum.Ex(E_ValidatorUnitCompareAttackPriority) { }
export class EValidatorUnitDetected extends CEnum.Ex(E_ValidatorUnitDetected) { }
export class EAbilLearn extends CEnum.Ex(E_AbilLearn) { }
export class EAbilRevive extends CEnum.Ex(E_AbilRevive) { }
export class EAbilInteract extends CEnum.Ex(E_AbilInteract) { }
export class EAbilMove extends CEnum.Ex(E_AbilMove) { }
export class EAbilStop extends CEnum.Ex(E_AbilStop) { }
export class EBoostedHeight extends CEnum.Ex(E_BoostedHeight) { }
export class ETerrainDeformerFlags extends CEnum.Ex(E_TerrainDeformerFlags) { }
export class EBehaviorVeterancy extends CEnum.Ex(E_BehaviorVeterancy) { }
export class ESharedXPRadius extends CEnum.Ex(E_SharedXPRadius) { }
export class ESharedXPFraction extends CEnum.Ex(E_SharedXPFraction) { }
export class EItem extends CEnum.Ex(E_Item) { }
export class EUserField extends CEnum.Ex(E_UserField) { }
export class EAbilSpecialize extends CEnum.Ex(E_AbilSpecialize) { }
export class EAbilRally extends CEnum.Ex(E_AbilRally) { }
export class EAchievement extends CEnum.Ex(E_Achievement) { }
export class EAchievementFilters extends CEnum.Ex(E_AchievementFilters) { }
export class EAchievementTerm extends CEnum.Ex(E_AchievementTerm) { }
export class EBundle extends CEnum.Ex(E_Bundle) { }
export class EObjectStates extends CEnum.Ex(E_ObjectStates) { }
export class EConversationState extends CEnum.Ex(E_ConversationState) { }
export class EFootprint extends CEnum.Ex(E_Footprint) { }
export class EPlayerLeave extends CEnum.Ex(E_PlayerLeave) { }
export class EBeaconInfoArray extends CEnum.Ex(E_BeaconInfoArray) { }
export class EClear extends CEnum.Ex(E_Clear) { }
export class EGameUIMixRouting extends CEnum.Ex(E_GameUIMixRouting) { }
export class EAnimFile extends CEnum.Ex(E_AnimFile) { }
export class EScoreResult extends CEnum.Ex(E_ScoreResult) { }
export class ESoundMixSnapshot extends CEnum.Ex(E_SoundMixSnapshot) { }
export class EMix extends CEnum.Ex(E_Mix) { }
export class ESoundtrack extends CEnum.Ex(E_Soundtrack) { }
export class EAbilCategories extends CEnum.Ex(E_AbilCategories) { }
export class EBehaviorPowerSource extends CEnum.Ex(E_BehaviorPowerSource) { }
export class EParamInitial extends CEnum.Ex(E_ParamInitial) { }
export class EDiffuseColor extends CEnum.Ex(E_DiffuseColor) { }
export class EDiffuseMultiplier extends CEnum.Ex(E_DiffuseMultiplier) { }
export class ECreepSettingsArray extends CEnum.Ex(E_CreepSettingsArray) { }
export class ESerpentAggregate extends CEnum.Ex(E_SerpentAggregate) { }
// Production levels are numeric in XML (`<ProductionLevel value="3"/>`); editor strings e_conversationProductionLevel0..4.
export class EConversationProductionLevel extends CEnum.FromArray(["0", "1", "2", "3", "4"] as const) { }
export class EAbilRedirect extends CEnum.Ex(E_AbilRedirect) { }
export class EAbilInventory extends CEnum.Ex(E_AbilInventory) { }
export class EAbilAttackModifier extends CEnum.Ex(E_AbilAttackModifier) { }
export class EActorQuad extends CEnum.Ex(E_ActorQuad) { }
export class ESelectionFlags extends CEnum.Ex(E_SelectionFlags) { }
export class ESelectionFilter extends CEnum.Ex(E_SelectionFilter) { }
export class ECloakTransitionArray extends CEnum.Ex(E_CloakTransitionArray) { }
export class EStateArray extends CEnum.Ex(E_StateArray) { }
export class ETerrainAndWaterFlags extends CEnum.Ex(E_TerrainAndWaterFlags) { }
export class ETipabilityFlags extends CEnum.Ex(E_TipabilityFlags) { }
export class ERegionFlags extends CEnum.Ex(E_RegionFlags) { }
export class ETests extends CEnum.Ex(E_Tests) { }
export class EAttackModifierFlags extends CEnum.Ex(E_AttackModifierFlags) { }
export class EShareFilters extends CEnum.Ex(E_ShareFilters) { }
export class ETargetFilters extends CEnum.Ex(E_TargetFilters) { }
export class EXPFraction extends CEnum.Ex(E_XPFraction) { }
export class ESCameraZoomParam extends CEnum.Ex(E_SCameraZoomParam) { }
export class EParamSmooth extends CEnum.Ex(E_ParamSmooth) { }
export class ESUIColorEntry extends CEnum.Ex(E_SUIColorEntry) { }
export class ECreepFlags extends CEnum.Ex(E_CreepFlags) { }
export class EDifficultyLevel extends CEnum.Ex(E_DifficultyLevel) { }
export class ETeleportResetRange extends CEnum.Ex(E_TeleportResetRange) { }
export class ESoundQuality extends CEnum.Ex(E_SoundQuality) { }
export class EGameUIDefaultPathColor extends CEnum.Ex(E_GameUIDefaultPathColor) { }
export class EGameUIDefaultPathLineWidth extends CEnum.Ex(E_GameUIDefaultPathLineWidth) { }
export class EGameUIDefaultPathTexture extends CEnum.Ex(E_GameUIDefaultPathTexture) { }
export class EGameUIDefaultPathTileLength extends CEnum.Ex(E_GameUIDefaultPathTileLength) { }
export class EGameUIDefaultPathStepModel extends CEnum.Ex(E_GameUIDefaultPathStepModel) { }
export class EGameUIDefaultPathStepModelScale extends CEnum.Ex(E_GameUIDefaultPathStepModelScale) { }
export class EGameUIPointModels extends CEnum.Ex(E_GameUIPointModels) { }
export class EGameUIOverrideColors extends CEnum.Ex(E_GameUIOverrideColors) { }
export class EGameUIColorBlindColors extends CEnum.Ex(E_GameUIColorBlindColors) { }
export class EGameUIBehaviorIconColors extends CEnum.Ex(E_GameUIBehaviorIconColors) { }
export class EGameUIBehaviorBorderColors extends CEnum.Ex(E_GameUIBehaviorBorderColors) { }
export class EGameUISelectionColors extends CEnum.Ex(E_GameUISelectionColors) { }
export class EGameUISelectionColorBlindColors extends CEnum.Ex(E_GameUISelectionColorBlindColors) { }
export class EDefaultGameVariantOptions extends CEnum.Ex(E_DefaultGameVariantOptions) { }
export class EHero extends CEnum.Ex(E_Hero) { }
export class EPreload extends CEnum.Ex(E_Preload) { }
export class EFoliageSettingsArray extends CEnum.Ex(E_FoliageSettingsArray) { }
export class ESamplingDistance extends CEnum.Ex(E_SamplingDistance) { }
export class EAcceptWorldForces extends CEnum.Ex(E_AcceptWorldForces) { }
export class EHeightFlags extends CEnum.Ex(E_HeightFlags) { }
export class ETile extends CEnum.Ex(E_Tile) { }
export class ESiteFlags extends CEnum.Ex(E_SiteFlags) { }
export class EActorTiltType extends CEnum.Ex(E_ActorTiltType) { }
export class EArmyCategory extends CEnum.Ex(E_ArmyCategory) { }
export class EDamageTypeResponse extends CEnum.Ex(E_DamageTypeResponse) { }
export class EConversationConditionOp extends CEnum.Ex(E_ConversationConditionOp) { }
export class EConversationSelectionMethod extends CEnum.Ex(E_ConversationSelectionMethod) { }
export class EConversationConditionCheck extends CEnum.Ex(E_ConversationConditionCheck) { }
export class EPathingConfig extends CEnum.Ex(E_PathingConfig) { }
export class ESoundExclusivity extends CEnum.Ex(E_SoundExclusivity) { }
export class ETextTagEdge extends CEnum.Ex(E_TextTagEdge) { }
export class EBankConditionCombine extends CEnum.Ex(E_BankConditionCombine) { }
export class EConversationActionOp extends CEnum.Ex(E_ConversationActionOp) { }
export class EModelFlags extends CEnum.Ex(E_ModelFlags) { }
export class EAbilInventoryAlignment extends CEnum.Ex(E_AbilInventoryAlignment) { }
export class EAbilLastTarget extends CEnum.Ex(E_AbilLastTarget) { }
export class EActorQuadDecoration extends CEnum.Ex(E_ActorQuadDecoration) { }
export class ERewardArray extends CEnum.Ex(E_RewardArray) { }
export class EAbilBehaviorCycleMode extends CEnum.Ex(E_AbilBehaviorCycleMode) { }
export class EAbilTrainLocation extends CEnum.Ex(E_AbilTrainLocation) { }
export class EAbilTrainRotation extends CEnum.Ex(E_AbilTrainRotation) { }
export class EAchievementTermPrevious extends CEnum.Ex(E_AchievementTermPrevious) { }
export class EActorModelMaterialType extends CEnum.Ex(E_ActorModelMaterialType) { }
export class EMinimapShape extends CEnum.Ex(E_MinimapShape) { }
export class EActorSiteBillboardType extends CEnum.Ex(E_ActorSiteBillboardType) { }
export class EActorSiteOpAttachSource extends CEnum.Ex(E_ActorSiteOpAttachSource) { }
export class EActorSiteOpOrientAttachPointToType extends CEnum.Ex(E_ActorSiteOpOrientAttachPointToType) { }
export class EActorSiteOpPhysicsImpactType extends CEnum.Ex(E_ActorSiteOpPhysicsImpactType) { }
export class EAMNumericField extends CEnum.Ex(E_AMNumericField) { }
export class EAMNumericFieldOp extends CEnum.Ex(E_AMNumericFieldOp) { }
export class EOscillator extends CEnum.Ex(E_Oscillator) { }
export class EMoverPatternType extends CEnum.Ex(E_MoverPatternType) { }
export class EBehaviorHeroicState extends CEnum.Ex(E_BehaviorHeroicState) { }
export class EFoliageLayer extends CEnum.Ex(E_FoliageLayer) { }
export class EPurchaseWarningCondition extends CEnum.Ex(E_PurchaseWarningCondition) { }
export class EResponseContinueMethod extends CEnum.Ex(E_ResponseContinueMethod) { }
export class EPreloadTiming extends CEnum.Ex(E_PreloadTiming) { }
export class EGameResult extends CEnum.Ex(E_GameResult) { }
export class EActorModelAspectPerson extends CEnum.Ex(E_ActorModelAspectPerson) { }
export class EActorModelAspectObservingPoV extends CEnum.Ex(E_ActorModelAspectObservingPoV) { }
export class EActorModelAspectRegardsAs extends CEnum.Ex(E_ActorModelAspectRegardsAs) { }
export class EActorModelAspectDuring extends CEnum.Ex(E_ActorModelAspectDuring) { }
export class EActorModelAspectObservedPlayerType extends CEnum.Ex(E_ActorModelAspectObservedPlayerType) { }
export class EActorModelAspectModelOwnerType extends CEnum.Ex(E_ActorModelAspectModelOwnerType) { }
export class EActorModelAspectTest extends CEnum.Ex(E_ActorModelAspectTest) { }
export class EActorQuadDecorationFunction extends CEnum.Ex(E_ActorQuadDecorationFunction) { }
export class EActorIntersectType extends CEnum.Ex(E_ActorIntersectType) { }
export class EActorAnimTransitionType extends CEnum.Ex(E_ActorAnimTransitionType) { }
export class EActorAnimPropMatchType extends CEnum.Ex(E_ActorAnimPropMatchType) { }
export class ESpeakerMode extends CEnum.Ex(E_SpeakerMode) { }
export class ESoundMaxMethod extends CEnum.Ex(E_SoundMaxMethod) { }
export class EModelQuality extends CEnum.Ex(E_ModelQuality) { }
export class EPhysicsMaterial extends CEnum.Ex(E_PhysicsMaterial) { }
export class ERequirementState extends CEnum.Ex(E_RequirementState) { }
export class EVoiceOverSkinState extends CEnum.Ex(E_VoiceOverSkinState) { }
export class ESoundMaxPrioritization extends CEnum.Ex(E_SoundMaxPrioritization) { }
export class EQuickCastMode extends CEnum.Ex(E_QuickCastMode) { }
export class EHerdClosestTo extends CEnum.Ex(E_HerdClosestTo) { }
export class EBehaviorUnitTrackerSnapRule extends CEnum.Ex(E_BehaviorUnitTrackerSnapRule) { }
export class EArtifactType extends CEnum.Ex(E_ArtifactType) { }
export class EActorForceOrigin extends CEnum.Ex(E_ActorForceOrigin) { }
export class EActorPlayerIdSource extends CEnum.Ex(E_ActorPlayerIdSource) { }
export class EActorSiteOpTetherEnableType extends CEnum.Ex(E_ActorSiteOpTetherEnableType) { }
export class EAbilAttackStage extends CEnum.Ex(E_AbilAttackStage) { }
export class EAbilBehaviorStage extends CEnum.Ex(E_AbilBehaviorStage) { }
export class EAbilBuildStage extends CEnum.Ex(E_AbilBuildStage) { }
export class EAbilEffectStage extends CEnum.Ex(E_AbilEffectStage) { }
export class EAbilHarvestStage extends CEnum.Ex(E_AbilHarvestStage) { }
export class EAbilMorphStage extends CEnum.Ex(E_AbilMorphStage) { }
export class EAbilRallyStage extends CEnum.Ex(E_AbilRallyStage) { }
export class EAbilArmMagazineCmd extends CEnum.Ex(E_AbilArmMagazineCmd) { }
export class EAbilAttackCmd extends CEnum.Ex(E_AbilAttackCmd) { }
export class EAbilAttackModifierCmd extends CEnum.Ex(E_AbilAttackModifierCmd) { }
export class EAbilAugmentCmd extends CEnum.Ex(E_AbilAugmentCmd) { }
export class EAbilBatteryCmd extends CEnum.Ex(E_AbilBatteryCmd) { }
export class EAbilBeaconCmd extends CEnum.Ex(E_AbilBeaconCmd) { }
export class EAbilBehaviorCmd extends CEnum.Ex(E_AbilBehaviorCmd) { }
export class EAbilBuildCmd extends CEnum.Ex(E_AbilBuildCmd) { }
export class EAbilBuildableCmd extends CEnum.Ex(E_AbilBuildableCmd) { }
export class EAbilEffectInstantCmd extends CEnum.Ex(E_AbilEffectInstantCmd) { }
export class EAbilEffectTargetCmd extends CEnum.Ex(E_AbilEffectTargetCmd) { }
export class EAbilHarvestCmd extends CEnum.Ex(E_AbilHarvestCmd) { }
export class EAbilInteractCmd extends CEnum.Ex(E_AbilInteractCmd) { }
export class EAbilInventoryCmd extends CEnum.Ex(E_AbilInventoryCmd) { }
export class EAbilLearnCmd extends CEnum.Ex(E_AbilLearnCmd) { }
export class EAbilMergeCmd extends CEnum.Ex(E_AbilMergeCmd) { }
export class EAbilMorphCmd extends CEnum.Ex(E_AbilMorphCmd) { }
export class EAbilMergeableCmd extends CEnum.Ex(E_AbilMergeableCmd) { }
export class EAbilMoveCmd extends CEnum.Ex(E_AbilMoveCmd) { }
export class EAbilPawnCmd extends CEnum.Ex(E_AbilPawnCmd) { }
export class EAbilQueueCmd extends CEnum.Ex(E_AbilQueueCmd) { }
export class EAbilRallyCmd extends CEnum.Ex(E_AbilRallyCmd) { }
export class EAbilRedirectInstantCmd extends CEnum.Ex(E_AbilRedirectInstantCmd) { }
export class EAbilRedirectTargetCmd extends CEnum.Ex(E_AbilRedirectTargetCmd) { }
export class EAbilResearchCmd extends CEnum.Ex(E_AbilResearchCmd) { }
export class EAbilReviveCmd extends CEnum.Ex(E_AbilReviveCmd) { }
export class EAbilSpecializeCmd extends CEnum.Ex(E_AbilSpecializeCmd) { }
export class EAbilStopCmd extends CEnum.Ex(E_AbilStopCmd) { }
export class EAbilTrainCmd extends CEnum.Ex(E_AbilTrainCmd) { }
export class EAbilTransportCmd extends CEnum.Ex(E_AbilTransportCmd) { }
export class EAbilWarpableCmd extends CEnum.Ex(E_AbilWarpableCmd) { }
export class EAbilWarpTrainCmd extends CEnum.Ex(E_AbilWarpTrainCmd) { }
export class EAbilityCategory extends CEnum.Ex(E_AbilityCategory) { }
export class EUnitStatusGroup extends CEnum.Ex(E_UnitStatusGroup) { }
export class EUnitStatus extends CEnum.Ex(E_UnitStatus) { }
export class EFlyerDisplay extends CEnum.Ex(E_FlyerDisplay) { }
export class EArmyCategoryState extends CEnum.Ex(E_ArmyCategoryState) { }
export class EArmyUnitState extends CEnum.Ex(E_ArmyUnitState) { }
export class EArmyUpgradeState extends CEnum.Ex(E_ArmyUpgradeState) { }
export class EBehaviorCategory extends CEnum.Ex(E_BehaviorCategory) { }
export class EAttackModifierStage extends CEnum.Ex(E_AttackModifierStage) { }
export class EDamageLocation extends CEnum.Ex(E_DamageLocation) { }
export class EUIColorMode extends CEnum.Ex(E_UIColorMode) { }
export class ECommanderTalentType extends CEnum.Ex(E_CommanderTalentType) { }
export class ECommanderMasteryTalentType extends CEnum.Ex(E_CommanderMasteryTalentType) { }
export class EPortraitOverlayType extends CEnum.Ex(E_PortraitOverlayType) { }
export class EAllianceId extends CEnum.Ex(E_AllianceId) { }
export class EAlliancePlayer extends CEnum.Ex(E_AlliancePlayer) { }
export class EFlagOperation extends CEnum.Ex(E_FlagOperation) { }
export class EPlayerType extends CEnum.Ex(E_PlayerType) { }
export class ETargetFilter extends CEnum.Ex(E_TargetFilter) { }
export class EMarkerMatch extends CEnum.Ex(E_MarkerMatch) { }
export class EHeightMap extends CEnum.Ex(E_HeightMap) { }
export class EPlane extends CEnum.Ex(E_Plane) { }
export class EAbilCmd extends CEnum.Ex(E_AbilCmd) { }
export class EPlacementTest extends CEnum.Ex(E_PlacementTest) { }
export class EUnitUserFlag extends CEnum.Ex(E_UnitUserFlag) { }
export class EUnitVital extends CEnum.Ex(E_UnitVital) { }
export class EDamageType extends CEnum.Ex(E_DamageType) { }
export class EDamageCategory extends CEnum.Ex(E_DamageCategory) { }
export class EAttackType extends CEnum.Ex(E_AttackType) { }
export class ECostDisplay extends CEnum.Ex(E_CostDisplay) { }
export class EEffectMissileSearch extends CEnum.Ex(E_EffectMissileSearch) { }
export class EAbilArmMagazineEffect extends CEnum.Ex(E_AbilArmMagazineEffect) { }
export class EConversationProductionLevelFlag extends CEnum.Ex(E_ConversationProductionLevelFlag) { }
export class EArmorType extends CEnum.Ex(E_ArmorType) { }
export class EDamageKind extends CEnum.Ex(E_DamageKind) { }
export class EDeathType extends CEnum.Ex(E_DeathType) { }
export class ECooldownOperation extends CEnum.Ex(E_CooldownOperation) { }
export class EResourceType extends CEnum.Ex(E_ResourceType) { }
export class EEffectLocation extends CEnum.Ex(E_EffectLocation) { }
export class EEffectPlayer extends CEnum.Ex(E_EffectPlayer) { }
export class EEffectUnit extends CEnum.Ex(E_EffectUnit) { }
export class ETeamColor extends CEnum.Ex(E_TeamColor) { }
export class ETechCategory extends CEnum.Ex(E_TechCategory) { }
export class EValueCompare extends CEnum.Ex(E_ValueCompare) { }
export class EBeacon extends CEnum.Ex(E_Beacon) { }
export class ECustomBuildOpening extends CEnum.Ex(E_CustomBuildOpening) { }
export class ECustomBuildLateGame extends CEnum.Ex(E_CustomBuildLateGame) { }
export class EUnitTaunt extends CEnum.Ex(E_UnitTaunt) { }
export class EEffectAmount extends CEnum.Ex(E_EffectAmount) { }
export class EEffectHistory extends CEnum.Ex(E_EffectHistory) { }
export class EUnitColorStyle extends CEnum.Ex(E_UnitColorStyle) { }
export class EHotkey extends CEnum.Ex(E_Hotkey) { }
export class EPathLocation extends CEnum.Ex(E_PathLocation) { }
export class ENydusLink extends CEnum.Ex(E_NydusLink) { }
export class EHeroState extends CEnum.Ex(E_HeroState) { }
export class EHeroAbilCategoryState extends CEnum.Ex(E_HeroAbilCategoryState) { }
export class EHeroCutsceneSize extends CEnum.Ex(E_HeroCutsceneSize) { }
export class EHeroFlag extends CEnum.Ex(E_HeroFlag) { }
export class EHeroRole extends CEnum.Ex(E_HeroRole) { }
export class EHeroDifficulty extends CEnum.Ex(E_HeroDifficulty) { }
export class EHeroVO extends CEnum.Ex(E_HeroVO) { }
export class EHeroGender extends CEnum.Ex(E_HeroGender) { }
export class EHeroUniverse extends CEnum.Ex(E_HeroUniverse) { }
export class EHeroAbilFlag extends CEnum.Ex(E_HeroAbilFlag) { }
export class EHeroImageFacing extends CEnum.Ex(E_HeroImageFacing) { }
export class EHeroAITalentBuildType extends CEnum.Ex(E_HeroAITalentBuildType) { }
export class EHeroAbilState extends CEnum.Ex(E_HeroAbilState) { }
export class EHeroStatState extends CEnum.Ex(E_HeroStatState) { }
export class EGameTimeEvent extends CEnum.Ex(E_GameTimeEvent) { }
export class ETimeOfDayValue extends CEnum.Ex(E_TimeOfDayValue) { }
export class EMissionState extends CEnum.Ex(E_MissionState) { }
export class EMapKind extends CEnum.Ex(E_MapKind) { }
export class EMountFlag extends CEnum.Ex(E_MountFlag) { }
export class EMountVO extends CEnum.Ex(E_MountVO) { }
export class EObjectiveType extends CEnum.Ex(E_ObjectiveType) { }
export class EObjectiveReward extends CEnum.Ex(E_ObjectiveReward) { }
export class EPingFlag extends CEnum.Ex(E_PingFlag) { }
export class ESoundCategory extends CEnum.Ex(E_SoundCategory) { }
export class ESoundtrackCategory extends CEnum.Ex(E_SoundtrackCategory) { }
export class ETalentModification extends CEnum.Ex(E_TalentModification) { }
export class ETalentProfileFlag extends CEnum.Ex(E_TalentProfileFlag) { }
export class EUnitFlag extends CEnum.Ex(E_UnitFlag) { }
export class EUnitCollide extends CEnum.Ex(E_UnitCollide) { }
export class EUnitAttribute extends CEnum.Ex(E_UnitAttribute) { }
export class ECmdFlags extends CEnum.Ex(E_CmdFlags) { }
export class EUpgradeOperation extends CEnum.Ex(E_UpgradeOperation) { }
export class EUserType extends CEnum.Ex(E_UserType) { }
export class EChance extends CEnum.Ex(E_Chance) { }
export class EFootprintLayer extends CEnum.Ex(E_FootprintLayer) { }
export class ENodeArray extends CEnum.Ex(E_NodeArray) { }
export class ESound extends CEnum.Ex(E_Sound) { }
export class EModel extends CEnum.Ex(E_Model) { }
export class ERequirementNode extends CEnum.Ex(E_RequirementNode) { }
export class ELightInfoParam extends CEnum.Ex(E_LightInfoParam) { }
export class ECameraScale extends CEnum.Ex(E_CameraScale) { }
export class EDamageMap extends CEnum.Ex(E_DamageMap) { }
export class EConversationLineObjects extends CEnum.Ex(E_ConversationLineObjects) { }
export class EMount extends CEnum.Ex(E_Mount) { }
export class EPing extends CEnum.Ex(E_Ping) { }
export class EResponseUnitBirthType extends CEnum.Ex(E_ResponseUnitBirthType) { }
export class ETalentProfile extends CEnum.Ex(E_TalentProfile) { }
export class EUnitUser extends CEnum.Ex(E_UnitUser) { }
export class EHeroAbil extends CEnum.Ex(E_HeroAbil) { }
export class ESharedXPMaxCount extends CEnum.Ex(E_SharedXPMaxCount) { }
export class EXPReceiveFraction extends CEnum.Ex(E_XPReceiveFraction) { }
export class EAbilRedirectTarget extends CEnum.Ex(E_AbilRedirectTarget) { }
export class ESoundLocaleFlags extends CEnum.Ex(E_SoundLocaleFlags) { }
export class EReplacementLayers extends CEnum.Ex(E_ReplacementLayers) { }
export class ESoundData extends CEnum.Ex(E_SoundData) { }
export class EAbilAttack extends CEnum.Ex(E_AbilAttack) { }
export class EAbilBattery extends CEnum.Ex(E_AbilBattery) { }
export class EAbilPawn extends CEnum.Ex(E_AbilPawn) { }
export class EActorModelMaterial extends CEnum.Ex(E_ActorModelMaterial) { }
export class EActorFilterAtCreation extends CEnum.Ex(E_ActorFilterAtCreation) { }
export class EActorVisibleToAtCreation extends CEnum.Ex(E_ActorVisibleToAtCreation) { }
export class EActorFilterPlayers extends CEnum.Ex(E_ActorFilterPlayers) { }
export class EActorVisibleToPlayers extends CEnum.Ex(E_ActorVisibleToPlayers) { }
export class EAccumulatorAttributePoints extends CEnum.Ex(E_AccumulatorAttributePoints) { }
export class EActorTextOptions extends CEnum.Ex(E_ActorTextOptions) { }
export class EDeltaSumFlags extends CEnum.Ex(E_DeltaSumFlags) { }
export class EAttachMethodBestMatch extends CEnum.Ex(E_AttachMethodBestMatch) { }
export class EWeaponIndexEnableArray extends CEnum.Ex(E_WeaponIndexEnableArray) { }
export class EWeaponIndexDisableArray extends CEnum.Ex(E_WeaponIndexDisableArray) { }
export class ETeleportTrack extends CEnum.Ex(E_TeleportTrack) { }
export class EEffectRedirectMissile extends CEnum.Ex(E_EffectRedirectMissile) { }
export class EAbilFlags extends CEnum.Ex(E_AbilFlags) { }
export class EEffectFlags extends CEnum.Ex(E_EffectFlags) { }
export class ETauntDoesntStopUnit extends CEnum.Ex(E_TauntDoesntStopUnit) { }
export class EPitchRoll extends CEnum.Ex(E_PitchRoll) { }
export class EAgainstCenter extends CEnum.Ex(E_AgainstCenter) { }
export class EOverkillType extends CEnum.Ex(E_OverkillType) { }
export class EHostSiteOpsSetHost extends CEnum.Ex(E_HostSiteOpsSetHost) { }
export class EActorClassFilter extends CEnum.Ex(E_ActorClassFilter) { }
export class EActorTableKey extends CEnum.Ex(E_ActorTableKey) { }
export class EAnimName extends CEnum.Ex(E_AnimName) { }
export class EPhysicsImpact extends CEnum.Ex(E_PhysicsImpact) { }
export class EPhysiqsMaterialCompare extends CEnum.Ex(E_PhysiqsMaterialCompare) { }
export class EAIUIMode extends CEnum.Ex(E_AIUIMode) { }
export class EAnimBracketExitReason extends CEnum.Ex(E_AnimBracketExitReason) { }
export class EGameEvent extends CEnum.Ex(E_GameEvent) { }
export class EGameSpeed extends CEnum.Ex(E_GameSpeed) { }
export class EStatus extends CEnum.Ex(E_Status) { }
export class EScope extends CEnum.Ex(E_Scope) { }
export class EOptionPhysics extends CEnum.Ex(E_OptionPhysics) { }
export class EFlyerHelper extends CEnum.Ex(E_FlyerHelper) { }
export class EMovement extends CEnum.Ex(E_Movement) { }
export class EAbilEvent extends CEnum.Ex(E_AbilEvent) { }
export class EAbilChargeEvent extends CEnum.Ex(E_AbilChargeEvent) { }
export class EAbilCooldownEvent extends CEnum.Ex(E_AbilCooldownEvent) { }
export class EAbilMorphEvent extends CEnum.Ex(E_AbilMorphEvent) { }
export class EAbilRallyEvent extends CEnum.Ex(E_AbilRallyEvent) { }
export class EAbilTrainEvent extends CEnum.Ex(E_AbilTrainEvent) { }
export class EAbilTransportEvent extends CEnum.Ex(E_AbilTransportEvent) { }
export class EBehaviorStackItemEvent extends CEnum.Ex(E_BehaviorStackItemEvent) { }
export class EBehaviorEvent extends CEnum.Ex(E_BehaviorEvent) { }
export class EHerdLevelEvent extends CEnum.Ex(E_HerdLevelEvent) { }
export class EHerdSpeedEvent extends CEnum.Ex(E_HerdSpeedEvent) { }
export class ETurretTargetEvent extends CEnum.Ex(E_TurretTargetEvent) { }
export class EUnitBlipUpdateEvent extends CEnum.Ex(E_UnitBlipUpdateEvent) { }
export class EUnitConstructionEvent extends CEnum.Ex(E_UnitConstructionEvent) { }
export class EUpgradeEvent extends CEnum.Ex(E_UpgradeEvent) { }
export class EUnitTauntEvent extends CEnum.Ex(E_UnitTauntEvent) { }
export class EUnitRegenEvent extends CEnum.Ex(E_UnitRegenEvent) { }
export class EUnitRefundEvent extends CEnum.Ex(E_UnitRefundEvent) { }
export class EUnitPortraitEvent extends CEnum.Ex(E_UnitPortraitEvent) { }
export class EUnitPointsEvent extends CEnum.Ex(E_UnitPointsEvent) { }
export class EUnitMovementUpdateEvent extends CEnum.Ex(E_UnitMovementUpdateEvent) { }
export class EUnitHighlightLocalEvent extends CEnum.Ex(E_UnitHighlightLocalEvent) { }
export class EUnitHeightUpdateEvent extends CEnum.Ex(E_UnitHeightUpdateEvent) { }
export class EUnitDetectedByViewerEvent extends CEnum.Ex(E_UnitDetectedByViewerEvent) { }
export class EWeaponCriticalUpdateEvent extends CEnum.Ex(E_WeaponCriticalUpdateEvent) { }
export class EWeaponStartEvent extends CEnum.Ex(E_WeaponStartEvent) { }
export class EWeaponStopEvent extends CEnum.Ex(E_WeaponStopEvent) { }
export class EAttachmentKey extends CEnum.Ex(E_AttachmentKey) { }
export class TLocaleId extends CEnum.Ex(E_LocaleId) { }
export class ETeamId extends CEnum.Ex(E_TeamId) { }
export class EAbilityorEffectType extends CEnum.Ex(E_AbilityorEffectType) { }
export class EDoodadType extends CEnum.Ex(E_DoodadType) { }
export class EClimate extends CEnum.Ex(E_Climate) { }
export class EObjectType extends CEnum.Ex(E_ObjectType) { }
export class EObjectFamily extends CEnum.Ex(E_ObjectFamily) { }
export class EConversationType extends CEnum.Ex(E_ConversationType) { }
export class EDataFamily extends CEnum.Ex(E_DataFamily) { }
export class EDataGroup extends CEnum.Ex(E_DataGroup) { }
export class EFootprintGroup extends CEnum.Ex(E_FootprintGroup) { }
export class ELightGroup extends CEnum.Ex(E_LightGroup) { }
export class ETechType extends CEnum.Ex(E_TechType) { }
export class ETerrainObjectType extends CEnum.Ex(E_TerrainObjectType) { }
export class EUpgradeType extends CEnum.Ex(E_UpgradeType) { }
export class EAnimBracketState extends CEnum.Ex(E_AnimBracketState) { }
export class EAnimDone extends CEnum.Ex(E_AnimDone) { }
export class EConfirmationEvent extends CEnum.Ex(E_ConfirmationEvent) { }
export class ESubName extends CEnum.Ex(E_SubName) { }
export class ESignal extends CEnum.Ex(E_Signal) { }
export class ERegionSubject extends CEnum.Ex(E_RegionSubject) { }
export class ESelection extends CEnum.Ex(E_Selection) { }
export class EBuildCoachHoverEvent extends CEnum.Ex(E_BuildCoachHoverEvent) { }
export class ButtonHoverEvent extends CEnum.Ex(E_ButtonHoverEvent) { }
export class ECursorUpdateEvent extends CEnum.Ex(E_CursorUpdateEvent) { }
export class EEffectEvent extends CEnum.Ex(E_EffectEvent) { }
export class EPhysicsImpactEvent extends CEnum.Ex(E_PhysicsImpactEvent) { }
export class ECutsceneEvent extends CEnum.Ex(E_CutsceneEvent) { }
export class EDigit extends CEnum.Ex(E_Digit) { }
export class ELetter extends CEnum.Ex(E_Letter) { }

export const DATA_ENUM_SCHEMA = {
  ECostDisplay, EEffectMissileSearch, EAbilArmMagazineEffect, EConversationProductionLevelFlag, EAbilCmdState, ECooldownLocation, EAbilAlignment, EChargeLocation, EAbilTechPlayer, EFogVisibility, EAttachKeyword, EActorScopeBearingsTrackingType, EActorRequestScope, EActorRequestActor, EActorEffectScope, EActorShieldFlashType, ESplatLayer, ECmdResult, EActorOverkillTestType, EActorSplatHeight, EAMFilterLogic, EEffectTimeScale, EBehaviorAlignment, EEffectLocationType, EDamageVisibility, EEffectModifyFacing, EOcclusion, EModelEvent, ESquibType, EMotionDriverType, EMotionOverlayType, EMotionOverlayPolarity, EMotionThrowRotationType, EMotionArrivalTestType, EMotionBlendType, EMotionTurnType, EMotionRotationActorType, ESoundDupe, ESoundMode, ESoundDupePriority, ESoundSelect, ETurretIdle, EUnitMob, ECostCategory, ECardButtonType, EAcquireLevel, EUnitResponse, EUnitDisplay, EDisplay, EValidateCombine, EUnitType, EWeaponLegacyMovement, EWeaponPrioritization, EAbilArmMagazineManage, EAbilOrderDisplayType, EVitalsAccumulatorModificationType, EActorHostedPropInheritType, EUnitSound, EAlertPeripheral, EBehaviorUnitTrackerAtMaxRule, EListWalkMode, EPathMode, EMotionActorTrackingType, EMotionRotationLaunchActorType, ETargetFindSet, EResourceState, EScoreValue, EScoreValueFlags, EVitalType, EUnitTestState, EActorForceField, EActorForceDirection, EEffectRemoveBehaviorAlignment, EEffectContainer, ECursorRangeMode, EAccumulatorOperation, EAccumulatorApplicationRule, EActorTextAlignment, ESoundBlend, ECargoSpace, EAMPatternType, EImplementionLevel, EVariationCommands, ETonemapRegionTypes, EPausedParticleSystemBehavior, EActorSoundPlayMode, ECharacterRace, EActorSoundValueSource, EUnitGender, EAbilBuildType, EAbilArmMagazineLaunch, EActorCrossbarDistribution, EActorIncomingType, EActorRequestCreateSharing, EActorHeightSourceType, EActorHeightTestType, EDamageResponseHandledValue, EAccumulatorBehaviorType, EActorProximity, EActorSiteOrbiterType, EDamageResponseDamageValue, EBehaviorBuffReplace, EDamageTotal, EKineticFollow, EBehaviorState, EAbilReviveVital, EAMRandomDistribution, EFootprintShapeMode, EDeathReveal, EEditorTextType, EAchievementTagCheck, EAchievementTermEvaluate, EAchievementTermCombine, EActorRadialDistribution, EActorResponseScope, EActorCombatRevealDurationType, ECharacterGender, ECharacterRelevance, EMuteControl, EVolumeControl, EGlueTheme, EScoreCollapse, EScoreSort, EScoreValueOperation, EScoreValueReport, EScoreValueType, EExclusivityAction, EExclusivityQueueAction, EVoiceOverSoundType, EAbilMorphPhase, EActorPhysicsImpactRangeType, ESerpentType, EActorSiteOpRotatorType, EAbilMorphSection, EActorSiteOpActionLocation, EActorSiteOpBasicType, EActorEffectLocation, EAMAttachType, EAMOccupancyLogic, EAMArcTestType, EAMFilterAttachType, EAMFilterType, EAMReductionType, ECameraHeightMap, ESoundFormat, ESoundResampler, EUIColorRelation, EGameCategoryUsage, ETargetModeValidation, EWeaponType, ESkillPoint, EUnitAIFlag, EPlayerRelationship, EAbilBehavior, EAbilEffect, EProgressButtonArray, ECancelEffect, EAbilityCategories, EAbilBuild, EEffectArray, EAbilTransport, EAbilMorph, ESectionArray, EDurationArray, EActorInherits, EActorTransfer, EActorFlags, EImpactMap, EActorModel, EActionFlags, EActorHostedPropTransfer, EDeathArray, ESoundArray, EUnitFlags, EActorFilter, EGroupSoundArray, EBaselines, EActorSquibMap, ERangeFlags, EInfoFlags, EDisplayDuration, EBehaviorModify, EBuffFlags, EBehaviorFlags, EHeightTime, ETooltipFlags, ESearchFlags, EResponse, EDamage, ECreateFlags, EEffectCreatePersistent, ETeleportFlags, EModifyFlags, EEffectReveal, EEffectApplyBehavior, EEffectLaunchMissile, ENotifyArea, ECmd, EDirectionalLight, ESAttachPropsKeys, ERace, EStartingUnit, ERequirement, EUpgrade, EWeaponOptions, EWeaponLegacyOptions, EAbilAugment, EAbilShared, EAbilArmMagazine, EAbilArmMagazineInfo, ECharge, ECliffLevelCompare, ETerrainSquibVisual, EAlertFlags, EAlertDisplay, EBehaviorPowerUser, EEffectCreateHealer, EEffectModifyTurret, ESelectionTransfer, ENegative, EPositive, EMover, EAdaptableParabolaDistances, EAdaptableParabolaAccels, ETargetFind, EEditor, EAbilQueue, EAbilMerge, EAlertArray, EForceFlags, ERateMultiplierArray, ETexture, EUnitTrackerFlags, EBehaviorResource, EMorphFlags, EEffectCancelOrder, EActorVisibleTo, EEffectBehavior, ECancelDelay, EAbilResearch, EAbilTrain, EAbilRedirectInstant, EAbilHarvest, EUseBuildTimeArray, EShadowFlags, EDamageResponseCategory, EAttackTypeResponse, EConjoinedFlags, EInfoIds, EEquipmentDisplay, EDisplayShield, EReward, EAbilSpecializeInfo, EAbilTrainInfo, EAbilWarpTrain, EActorDoodad, EActorPhysicsData, ESoundFlags, EAlertPrimaryActions, EAlertSecondaryActions, EBehaviorSpawn, EPlacementArray, EPathingDataBits, EPathingType, EValidatorUnitCompareAttackPriority, EValidatorUnitDetected, EAbilLearn, EAbilRevive, EAbilInteract, EAbilMove, EAbilStop, EBoostedHeight, ETerrainDeformerFlags, EBehaviorVeterancy, ESharedXPRadius, ESharedXPFraction, EItem, EUserField, EAbilSpecialize, EAbilRally, EAchievement, EAchievementFilters, EAchievementTerm, EBundle, EObjectStates, EConversationState, EFootprint, EPlayerLeave, EBeaconInfoArray, EClear, EGameUIMixRouting, EAnimFile, EScoreResult, ESoundMixSnapshot, EMix, ESoundtrack, EAbilCategories, EBehaviorPowerSource, EParamInitial, EDiffuseColor, EDiffuseMultiplier, ECreepSettingsArray, ESerpentAggregate, EConversationProductionLevel, EAbilRedirect, EAbilInventory, EAbilAttackModifier, EActorQuad, ESelectionFlags, ESelectionFilter, ECloakTransitionArray, EStateArray, ETerrainAndWaterFlags, ETipabilityFlags, ERegionFlags, ETests, EAttackModifierFlags, EShareFilters, ETargetFilters, EXPFraction, ESCameraZoomParam, EParamSmooth, ESUIColorEntry, ECreepFlags, EDifficultyLevel, ETeleportResetRange, ESoundQuality, EGameUIDefaultPathColor, EGameUIDefaultPathLineWidth, EGameUIDefaultPathTexture, EGameUIDefaultPathTileLength, EGameUIDefaultPathStepModel, EGameUIDefaultPathStepModelScale, EGameUIPointModels, EGameUIOverrideColors, EGameUIColorBlindColors, EGameUIBehaviorIconColors, EGameUIBehaviorBorderColors, EGameUISelectionColors, EGameUISelectionColorBlindColors, EDefaultGameVariantOptions, EHero, EPreload, EFoliageSettingsArray, ESamplingDistance, EAcceptWorldForces, EHeightFlags, ETile, ESiteFlags, EActorTiltType, EArmyCategory, EDamageTypeResponse, EConversationConditionOp, EConversationSelectionMethod, EConversationConditionCheck, EPathingConfig, ESoundExclusivity, ETextTagEdge, EBankConditionCombine, EConversationActionOp, EModelFlags, EAbilInventoryAlignment, EAbilLastTarget, EActorQuadDecoration, ERewardArray, EAbilBehaviorCycleMode, EAbilTrainLocation, EAbilTrainRotation, EAchievementTermPrevious, EActorModelMaterialType, EMinimapShape, EActorSiteBillboardType, EActorSiteOpAttachSource, EActorSiteOpOrientAttachPointToType, EActorSiteOpPhysicsImpactType, EAMNumericField, EAMNumericFieldOp, EOscillator, EMoverPatternType, EBehaviorHeroicState, EFoliageLayer, EPurchaseWarningCondition, EResponseContinueMethod, EPreloadTiming, EGameResult, EActorModelAspectPerson, EActorModelAspectObservingPoV, EActorModelAspectRegardsAs, EActorModelAspectDuring, EActorModelAspectObservedPlayerType, EActorModelAspectModelOwnerType, EActorModelAspectTest, EActorQuadDecorationFunction, EActorIntersectType, EActorAnimTransitionType, EActorAnimPropMatchType, ESpeakerMode, ESoundMaxMethod, EModelQuality, EPhysicsMaterial, ERequirementState, EVoiceOverSkinState, ESoundMaxPrioritization, EQuickCastMode, EHerdClosestTo, EBehaviorUnitTrackerSnapRule, EArtifactType, EActorForceOrigin, EActorPlayerIdSource, EActorSiteOpTetherEnableType, EAbilAttackStage, EAbilBehaviorStage, EAbilBuildStage, EAbilEffectStage, EAbilHarvestStage, EAbilMorphStage, EAbilRallyStage, EAbilArmMagazineCmd, EAbilAttackCmd, EAbilAttackModifierCmd, EAbilAugmentCmd, EAbilBatteryCmd, EAbilBeaconCmd, EAbilBehaviorCmd, EAbilBuildCmd, EAbilBuildableCmd, EAbilEffectInstantCmd, EAbilEffectTargetCmd, EAbilHarvestCmd, EAbilInteractCmd, EAbilInventoryCmd, EAbilLearnCmd, EAbilMergeCmd, EAbilMorphCmd, EAbilMergeableCmd, EAbilMoveCmd, EAbilPawnCmd, EAbilQueueCmd, EAbilRallyCmd, EAbilRedirectInstantCmd, EAbilRedirectTargetCmd, EAbilResearchCmd, EAbilReviveCmd, EAbilSpecializeCmd, EAbilStopCmd, EAbilTrainCmd, EAbilTransportCmd, EAbilWarpableCmd, EAbilWarpTrainCmd, EAbilityCategory, EUnitStatusGroup, EUnitStatus, EFlyerDisplay, EArmyCategoryState, EArmyUnitState, EArmyUpgradeState, EBehaviorCategory, EAttackModifierStage, EDamageLocation, EUIColorMode, ECommanderTalentType, ECommanderMasteryTalentType, EPortraitOverlayType, EAllianceId, EAlliancePlayer, EFlagOperation, EPlayerType, ETargetFilter, EMarkerMatch, EHeightMap, EPlane, EAbilCmd, EPlacementTest, EUnitUserFlag, EUnitVital, EDamageType, EDamageCategory, EAttackType, EArmorType, EDamageKind, EDeathType, ECooldownOperation, EResourceType, EEffectLocation, EEffectPlayer, EEffectUnit, ETeamColor, ETechCategory, EValueCompare, EBeacon, ECustomBuildOpening, ECustomBuildLateGame, EUnitTaunt, EEffectAmount, EEffectHistory, EUnitColorStyle, EHotkey, EPathLocation, ENydusLink, EHeroState, EHeroAbilCategoryState, EHeroCutsceneSize, EHeroFlag, EHeroRole, EHeroDifficulty, EHeroVO, EHeroGender, EHeroUniverse, EHeroAbilFlag, EHeroImageFacing, EHeroAITalentBuildType, EHeroAbilState, EHeroStatState, EGameTimeEvent, ETimeOfDayValue, EMissionState, EMapKind, EMountFlag, EMountVO, EObjectiveType, EObjectiveReward, EPingFlag, ESoundCategory, ESoundtrackCategory, ETalentModification, ETalentProfileFlag, EUnitFlag, EUnitCollide, EUnitAttribute, ECmdFlags, EUpgradeOperation, EUserType, EChance, EFootprintLayer, ENodeArray, EAbilityorEffectType, EDoodadType, EClimate, EObjectType, EObjectFamily, EConversationType, EDataFamily, EDataGroup, EFootprintGroup, ELightGroup, ETechType, ETerrainObjectType, EUpgradeType, ESound, EModel, ERequirementNode, ELightInfoParam, ECameraScale, EDamageMap, EConversationLineObjects, EMount, EPing, EResponseUnitBirthType, ETalentProfile, EUnitUser, EHeroAbil, ESharedXPMaxCount, EXPReceiveFraction, EAbilRedirectTarget, ESoundLocaleFlags, EReplacementLayers, ESoundData, EAbilAttack, EAbilBattery, EAbilPawn, EActorModelMaterial, EActorFilterAtCreation, EActorVisibleToAtCreation, EActorFilterPlayers, EActorVisibleToPlayers, EAccumulatorAttributePoints, EActorTextOptions, EDeltaSumFlags, EAttachMethodBestMatch, EWeaponIndexEnableArray, EWeaponIndexDisableArray, ETeleportTrack, EEffectRedirectMissile, EAbilFlags, EEffectFlags, ETauntDoesntStopUnit
} as const

// #region Enum Examples
// let eClassId = new EClassId("CAbil")
// eClassId.value = "CAbilBattery"
// eClassId.value = "ERROR"

// let eHotkey = new EHotkey("AIDelete")
// eHotkey.value = "VideoRecord"
// eHotkey.value = "ERROR"
